import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant, TenantRegistry, LobsterdConfig } from '../types/index.js';
import { loadConfig, loadRegistry, saveRegistry } from '../config/loader.js';
import { TENANT_NAME_REGEX } from '../config/schema.js';
import * as image from '../system/image.js';
import * as network from '../system/network.js';
import * as fc from '../system/firecracker.js';
import * as vsock from '../system/vsock.js';
import * as caddy from '../system/caddy.js';
import * as jailer from '../system/jailer.js';

export interface SpawnProgress {
  step: string;
  detail: string;
}

type UndoFn = () => ResultAsync<void, LobsterError>;

function computeSubnetIps(subnetBase: string, subnetIndex: number): { hostIp: string; guestIp: string } {
  const parts = subnetBase.split('.').map(Number);
  // Each /30 subnet uses 4 addresses: network, host, guest, broadcast
  const offset = subnetIndex * 4;
  const base = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const subnetAddr = base + offset;
  const hostAddr = subnetAddr + 1;
  const guestAddr = subnetAddr + 2;
  const toIp = (n: number) => `${(n >> 24) & 0xff}.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
  return { hostIp: toIp(hostAddr), guestIp: toIp(guestAddr) };
}

export function runSpawn(
  name: string,
  onProgress?: (p: SpawnProgress) => void,
): ResultAsync<Tenant, LobsterError> {
  const progress = (step: string, detail: string) => onProgress?.({ step, detail });

  if (!TENANT_NAME_REGEX.test(name)) {
    return errAsync({
      code: 'VALIDATION_FAILED',
      message: `Invalid tenant name "${name}": must match ${TENANT_NAME_REGEX}`,
    });
  }

  let config: LobsterdConfig;
  let registry: TenantRegistry;
  let tenant: Tenant;
  let vmProcPid: number | null = null;
  const undoStack: UndoFn[] = [];

  function rollback(error: LobsterError): ResultAsync<never, LobsterError> {
    if (undoStack.length === 0) return errAsync(error);
    const fns = [...undoStack].reverse();
    let count = 0;
    let chain: ResultAsync<void, LobsterError> = okAsync(undefined);
    for (const fn of fns) {
      chain = chain.andThen(() => fn().orElse(() => okAsync(undefined))).map(() => { count++; });
    }
    return chain.andThen(() =>
      errAsync({
        ...error,
        message: `${error.message} (rolled back ${count}/${fns.length} steps)`,
      }),
    );
  }

  return loadConfig()
    .andThen((c) => {
      config = c;
      return loadRegistry();
    })
    .andThen((r): ResultAsync<void, LobsterError> => {
      registry = r;

      if (registry.tenants.some((t) => t.name === name)) {
        return errAsync({ code: 'TENANT_EXISTS', message: `Tenant "${name}" already exists` });
      }

      const cid = registry.nextCid;
      const subnetIndex = registry.nextSubnetIndex;
      const gatewayPort = registry.nextGatewayPort;
      const jailUid = registry.nextJailUid;
      const { hostIp, guestIp } = computeSubnetIps(config.network.subnetBase, subnetIndex);
      const tapDev = `tap-${name}`;
      const vmId = `vm-${name}`;
      const overlayPath = `${config.overlay.baseDir}/${name}.ext4`;
      const socketPath = jailer.getApiSocketPath(config.jailer.chrootBaseDir, vmId);

      tenant = {
        name,
        vmId,
        cid,
        ipAddress: guestIp,
        hostIp,
        tapDev,
        gatewayPort,
        overlayPath,
        socketPath,
        vmPid: null,
        createdAt: new Date().toISOString(),
        status: 'active',
        gatewayToken: crypto.randomUUID(),
        jailUid,
        agentToken: crypto.randomUUID(),
      };

      // Step 1: Create overlay
      progress('overlay', `Creating overlay ${overlayPath} (${config.overlay.defaultSizeMb}MB)`);
      return image.createOverlay(overlayPath, config.overlay.defaultSizeMb);
    })
    .andThen(() => {
      undoStack.push(() => image.deleteOverlay(tenant.overlayPath));

      // Step 2: Create TAP device
      progress('network', `Creating TAP ${tenant.tapDev} (host=${tenant.hostIp}, guest=${tenant.ipAddress})`);
      return network.createTap(tenant.tapDev, tenant.hostIp, tenant.ipAddress);
    })
    .andThen(() => {
      undoStack.push(() => network.deleteTap(tenant.tapDev));

      // Step 3: Add NAT rules
      progress('nat', `Adding NAT rules for port ${tenant.gatewayPort}`);
      return network.addNat(tenant.tapDev, tenant.ipAddress, tenant.gatewayPort);
    })
    .andThen(() => {
      undoStack.push(() => network.removeNat(tenant.tapDev, tenant.ipAddress, tenant.gatewayPort));

      // Step 4: Add network isolation rules (FORWARD + INPUT)
      progress('isolation', 'Adding network isolation rules');
      return network.addIsolationRules(tenant.tapDev);
    })
    .andThen(() => {
      undoStack.push(() => network.removeIsolationRules(tenant.tapDev));

      // Step 5: Spawn Firecracker via jailer
      progress('firecracker', 'Starting Firecracker microVM via jailer');

      // Clean up any stale jailer chroot from a previous failed run
      return jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId);
    })
    .andThen(() => {
      return ResultAsync.fromPromise(
        (async () => {
          const args = jailer.buildJailerArgs(
            config.jailer,
            config.firecracker.binaryPath,
            tenant.vmId,
            tenant.jailUid,
          );
          const proc = Bun.spawn(args, {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          proc.unref();
          vmProcPid = proc.pid;
          // Give jailer time to set up chroot and exec Firecracker
          await Bun.sleep(800);
        })(),
        (e): LobsterError => ({
          code: 'VM_BOOT_FAILED',
          message: `Failed to spawn jailer: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      );
    })
    .andThen(() => {
      undoStack.push(() =>
        ResultAsync.fromSafePromise(
          (async () => {
            if (vmProcPid) {
              try { process.kill(vmProcPid, 'SIGKILL'); } catch {}
            }
            await jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId);
          })(),
        ),
      );

      // Step 6: Hard-link drive and kernel files into jailer chroot
      progress('chroot', 'Linking drive files into jailer chroot');
      return jailer.linkChrootFiles(
        config.jailer.chrootBaseDir,
        tenant.vmId,
        config.firecracker.kernelPath,
        config.firecracker.rootfsPath,
        tenant.overlayPath,
        tenant.jailUid,
      );
    })
    .andThen(() => {
      // Step 7: Configure VM via Firecracker API (paths are chroot-relative)
      progress('vm-config', `Configuring VM (${config.firecracker.defaultVcpuCount} vCPU, ${config.firecracker.defaultMemSizeMb}MB RAM)`);
      return fc.configureVm(tenant.socketPath, {
        vcpuCount: config.firecracker.defaultVcpuCount,
        memSizeMib: config.firecracker.defaultMemSizeMb,
      });
    })
    .andThen(() => {
      const bootArgs = [
        'reboot=k',
        'panic=1',
        'pci=off',
        '8250.nr_uarts=0',
        'init=/sbin/overlay-init',
        `ip=${tenant.ipAddress}::${tenant.hostIp}:255.255.255.252::eth0:off`,
        `agent_token=${tenant.agentToken}`,
      ].join(' ');
      progress('boot-source', 'Setting boot source');
      return fc.setBootSource(tenant.socketPath, '/vmlinux', bootArgs);
    })
    .andThen(() => {
      progress('drives', 'Adding rootfs and overlay drives');
      return fc.addDrive(tenant.socketPath, 'rootfs', '/rootfs.ext4', true, config.firecracker.diskRateLimit);
    })
    .andThen(() => fc.addDrive(tenant.socketPath, 'overlay', '/overlay.ext4', false, config.firecracker.diskRateLimit))
    .andThen(() => {
      progress('vsock', `Adding vsock (CID ${tenant.cid})`);
      return fc.addVsock(tenant.socketPath, tenant.cid);
    })
    .andThen(() => {
      progress('net-iface', `Adding network interface on ${tenant.tapDev}`);
      return fc.addNetworkInterface(
        tenant.socketPath,
        'eth0',
        tenant.tapDev,
        config.firecracker.networkRxRateLimit,
        config.firecracker.networkTxRateLimit,
      );
    })
    .andThen(() => {
      progress('start', 'Starting VM instance');
      return fc.startInstance(tenant.socketPath);
    })
    .andThen(() => {
      tenant.vmPid = vmProcPid;

      // Step 8: Wait for guest agent
      progress('agent', 'Waiting for guest agent to respond on TCP');
      return vsock.waitForAgent(tenant.ipAddress, config.vsock.agentPort, config.vsock.connectTimeoutMs);
    })
    .andThen(() => {
      // Step 9: Inject secrets (build per-tenant config with correct origin)
      progress('secrets', 'Injecting API keys and gateway token');
      const tenantOrigin = `https://${name}.${config.caddy.domain}`;
      const tenantConfig = structuredClone(config.openclaw.defaultConfig);
      const origins = tenantConfig.gateway?.controlUi?.allowedOrigins ?? [];
      if (!origins.includes(tenantOrigin)) origins.push(tenantOrigin);
      if (tenantConfig.gateway?.controlUi) tenantConfig.gateway.controlUi.allowedOrigins = origins;
      return vsock.injectSecrets(tenant.ipAddress, config.vsock.agentPort, {
        OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
        OPENCLAW_CONFIG: JSON.stringify(tenantConfig),
      }, tenant.agentToken);
    })
    .andThen(() => {
      // Step 10: Add Caddy route
      progress('caddy', `Adding Caddy route for ${name}.${config.caddy.domain}`);
      return caddy.addRoute(config.caddy.adminApi, name, config.caddy.domain, tenant.ipAddress, 9000);
    })
    .andThen(() => {
      undoStack.push(() => caddy.removeRoute(config.caddy.adminApi, name));

      // Step 11: Save to registry
      progress('registry', 'Registering tenant');
      registry.tenants.push(tenant);
      registry.nextCid += 1;
      registry.nextSubnetIndex += 1;
      registry.nextGatewayPort += 1;
      registry.nextJailUid += 1;
      return saveRegistry(registry);
    })
    .map(() => tenant)
    .orElse((error) => rollback(error));
}
