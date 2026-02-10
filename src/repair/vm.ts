import { ResultAsync, okAsync } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError, LobsterdConfig } from '../types/index.js';
import { SOCKETS_DIR } from '../config/defaults.js';
import * as fc from '../system/firecracker.js';
import * as vsock from '../system/vsock.js';
import { exec } from '../system/exec.js';

export function repairVmProcess(tenant: Tenant, config: LobsterdConfig): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  // Kill stale process if any
  return ResultAsync.fromSafePromise(
    (async () => {
      if (tenant.vmPid) {
        try { process.kill(tenant.vmPid, 'SIGKILL'); } catch {}
        actions.push(`Killed stale VM process ${tenant.vmPid}`);
      }
    })(),
  )
    .andThen(() => exec(['rm', '-f', tenant.socketPath, `${tenant.socketPath}.vsock`]).orElse(() => okAsync({ exitCode: 0, stdout: '', stderr: '' })))
    .andThen(() => {
      actions.push('Cleaned up stale socket');

      // Re-spawn Firecracker
      return ResultAsync.fromPromise(
        (async () => {
          const proc = Bun.spawn([
            config.firecracker.binaryPath,
            '--api-sock', tenant.socketPath,
          ], {
            stdout: 'ignore',
            stderr: 'ignore',
          });
          proc.unref();
          tenant.vmPid = proc.pid;
          await Bun.sleep(500);
          actions.push(`Started new Firecracker process (PID ${proc.pid})`);
        })(),
        (e): LobsterError => ({ code: 'VM_BOOT_FAILED', message: String(e) }),
      );
    })
    .andThen(() =>
      fc.configureVm(tenant.socketPath, {
        vcpuCount: config.firecracker.defaultVcpuCount,
        memSizeMib: config.firecracker.defaultMemSizeMb,
      }),
    )
    .andThen(() => {
      const bootArgs = [
        'console=ttyS0', 'reboot=k', 'panic=1', 'pci=off',
        'init=/sbin/overlay-init',
        `ip=${tenant.ipAddress}::${tenant.hostIp}:255.255.255.252::eth0:off`,
      ].join(' ');
      return fc.setBootSource(tenant.socketPath, config.firecracker.kernelPath, bootArgs);
    })
    .andThen(() => fc.addDrive(tenant.socketPath, 'rootfs', config.firecracker.rootfsPath, true))
    .andThen(() => fc.addDrive(tenant.socketPath, 'overlay', tenant.overlayPath, false))
    .andThen(() => fc.addVsock(tenant.socketPath, tenant.cid))
    .andThen(() => fc.addNetworkInterface(tenant.socketPath, 'eth0', tenant.tapDev))
    .andThen(() => fc.startInstance(tenant.socketPath))
    .andThen(() => {
      actions.push('VM started successfully');
      return vsock.waitForAgent(tenant.ipAddress, config.vsock.agentPort, config.vsock.connectTimeoutMs);
    })
    .andThen(() => {
      actions.push('Guest agent responded');
      return vsock.injectSecrets(tenant.ipAddress, config.vsock.agentPort, {
        OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
        OPENCLAW_CONFIG: JSON.stringify(config.openclaw.defaultConfig),
      });
    })
    .map((): RepairResult => ({
      repair: 'vm.process',
      fixed: true,
      actions,
    }))
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: 'vm.process',
        fixed: false,
        actions: [...actions, 'Failed to restart VM'],
      }),
    );
}

export function repairVmResponsive(tenant: Tenant, config: LobsterdConfig): ResultAsync<RepairResult, LobsterError> {
  // Re-inject secrets if agent unresponsive
  return vsock.injectSecrets(tenant.ipAddress, config.vsock.agentPort, {
    OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
    OPENCLAW_CONFIG: JSON.stringify(config.openclaw.defaultConfig),
  })
    .map((): RepairResult => ({
      repair: 'vm.responsive',
      fixed: true,
      actions: ['Re-injected secrets via TCP'],
    }))
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: 'vm.responsive',
        fixed: false,
        actions: ['Failed to re-inject secrets — VM may need full restart'],
      }),
    );
}
