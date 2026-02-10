import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant, TenantRegistry, LobsterdConfig } from '../types/index.js';
import { loadConfig, loadRegistry, saveRegistry } from '../config/loader.js';
import { TENANT_NAME_REGEX } from '../config/schema.js';
import { SOCKETS_DIR } from '../config/defaults.js';
import * as image from '../system/image.js';
import * as network from '../system/network.js';
import * as fc from '../system/firecracker.js';
import * as vsock from '../system/vsock.js';
import * as caddy from '../system/caddy.js';
import { exec } from '../system/exec.js';

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
      const { hostIp, guestIp } = computeSubnetIps(config.network.subnetBase, subnetIndex);
      const tapDev = `tap-${name}`;
      const vmId = `vm-${name}`;
      const overlayPath = `${config.overlay.baseDir}/${name}.ext4`;
      const socketPath = `${SOCKETS_DIR}/${name}.sock`;

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

      // Step 4: Spawn Firecracker process
      progress('firecracker', 'Starting Firecracker microVM');

      // Clean up any stale socket
      return exec(['rm', '-f', tenant.socketPath]).orElse(() => okAsync({ exitCode: 0, stdout: '', stderr: '' }));
    })
    .andThen(() => {
      return ResultAsync.fromPromise(
        (async () => {
          const proc = Bun.spawn([
            config.firecracker.binaryPath,
            '--api-sock', tenant.socketPath,
          ], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          vmProcPid = proc.pid;
          // Give Firecracker a moment to create the socket
          await Bun.sleep(500);
        })(),
        (e): LobsterError => ({
          code: 'VM_BOOT_FAILED',
          message: `Failed to spawn Firecracker: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      );
    })
    .andThen(() => {
      undoStack.push(() =>
        ResultAsync.fromPromise(
          (async () => {
            if (vmProcPid) {
              try { process.kill(vmProcPid, 'SIGKILL'); } catch {}
            }
            await exec(['rm', '-f', tenant.socketPath]);
          })(),
          () => ({ code: 'EXEC_FAILED' as const, message: 'Failed to kill VM' }),
        ),
      );

      // Step 5: Configure VM via Firecracker API
      progress('vm-config', `Configuring VM (${config.firecracker.defaultVcpuCount} vCPU, ${config.firecracker.defaultMemSizeMb}MB RAM)`);
      return fc.configureVm(tenant.socketPath, {
        vcpuCount: config.firecracker.defaultVcpuCount,
        memSizeMib: config.firecracker.defaultMemSizeMb,
      });
    })
    .andThen(() => {
      const bootArgs = [
        'console=ttyS0',
        'reboot=k',
        'panic=1',
        'pci=off',
        `ip=${tenant.ipAddress}::${tenant.hostIp}:255.255.255.252::eth0:off`,
      ].join(' ');
      progress('boot-source', 'Setting boot source');
      return fc.setBootSource(tenant.socketPath, config.firecracker.kernelPath, bootArgs);
    })
    .andThen(() => {
      progress('drives', 'Adding rootfs and overlay drives');
      return fc.addDrive(tenant.socketPath, 'rootfs', config.firecracker.rootfsPath, true);
    })
    .andThen(() => fc.addDrive(tenant.socketPath, 'overlay', tenant.overlayPath, false))
    .andThen(() => {
      progress('vsock', `Adding vsock (CID ${tenant.cid})`);
      return fc.addVsock(tenant.socketPath, tenant.cid);
    })
    .andThen(() => {
      progress('net-iface', `Adding network interface on ${tenant.tapDev}`);
      return fc.addNetworkInterface(tenant.socketPath, 'eth0', tenant.tapDev);
    })
    .andThen(() => {
      progress('start', 'Starting VM instance');
      return fc.startInstance(tenant.socketPath);
    })
    .andThen(() => {
      tenant.vmPid = vmProcPid;

      // Step 6: Wait for guest agent
      progress('agent', 'Waiting for guest agent to respond on vsock');
      return vsock.waitForAgent(tenant.cid, config.vsock.agentPort, config.vsock.connectTimeoutMs);
    })
    .andThen(() => {
      // Step 7: Inject secrets
      progress('secrets', 'Injecting API keys and gateway token');
      return vsock.injectSecrets(tenant.cid, config.vsock.agentPort, {
        OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
        OPENCLAW_CONFIG: JSON.stringify(config.openclaw.defaultConfig),
      });
    })
    .andThen(() => {
      // Step 8: Add Caddy route
      progress('caddy', `Adding Caddy route for ${name}.${config.caddy.domain}`);
      return caddy.addRoute(config.caddy.adminApi, name, config.caddy.domain, tenant.gatewayPort);
    })
    .andThen(() => {
      undoStack.push(() => caddy.removeRoute(config.caddy.adminApi, name));

      // Step 9: Save to registry
      progress('registry', 'Registering tenant');
      registry.tenants.push(tenant);
      registry.nextCid += 1;
      registry.nextSubnetIndex += 1;
      registry.nextGatewayPort += 1;
      return saveRegistry(registry);
    })
    .map(() => tenant)
    .orElse((error) => rollback(error));
}
