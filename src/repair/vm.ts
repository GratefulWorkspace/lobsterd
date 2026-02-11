import { okAsync, ResultAsync } from "neverthrow";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import type {
  LobsterdConfig,
  LobsterError,
  RepairResult,
  Tenant,
} from "../types/index.js";


export function repairVmProcess(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  // Kill stale process if any
  return ResultAsync.fromSafePromise(
    (async () => {
      if (tenant.vmPid) {
        try {
          process.kill(tenant.vmPid, "SIGKILL");
        } catch {}
        actions.push(`Killed stale VM process ${tenant.vmPid}`);
      }
    })(),
  )
    .andThen(() =>
      jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId),
    )
    .andThen(() => {
      actions.push("Cleaned up stale jailer chroot");

      // Re-spawn via jailer
      return ResultAsync.fromPromise(
        (async () => {
          const memLimitBytes =
            (config.firecracker.defaultMemSizeMb + 128) * 1024 * 1024;
          const cpuQuotaUs = config.firecracker.defaultVcpuCount * 100_000;
          const args = jailer.buildJailerArgs(
            config.jailer,
            config.firecracker.binaryPath,
            tenant.vmId,
            tenant.jailUid,
            { memLimitBytes, cpuQuotaUs, cpuPeriodUs: 100_000 },
          );
          const proc = Bun.spawn(args, {
            stdout: "ignore",
            stderr: "ignore",
          });
          proc.unref();
          tenant.vmPid = proc.pid;
          await Bun.sleep(800);
          actions.push(`Started new Firecracker via jailer (PID ${proc.pid})`);
        })(),
        (e): LobsterError => ({ code: "VM_BOOT_FAILED", message: String(e) }),
      );
    })
    .andThen(() =>
      jailer.linkChrootFiles(
        config.jailer.chrootBaseDir,
        tenant.vmId,
        config.firecracker.kernelPath,
        config.firecracker.rootfsPath,
        tenant.overlayPath,
        tenant.jailUid,
      ),
    )
    .andThen(() =>
      fc.configureVm(tenant.socketPath, {
        vcpuCount: config.firecracker.defaultVcpuCount,
        memSizeMib: config.firecracker.defaultMemSizeMb,
      }),
    )
    .andThen(() => {
      const bootArgs = [
        "reboot=k",
        "panic=1",
        "pci=off",
        "8250.nr_uarts=0",
        "init=/sbin/overlay-init",
        `ip=${tenant.ipAddress}::${tenant.hostIp}:255.255.255.252::eth0:off`,
        `agent_token=${tenant.agentToken}`,
      ].join(" ");
      return fc.setBootSource(tenant.socketPath, "/vmlinux", bootArgs);
    })
    .andThen(() =>
      fc.addDrive(
        tenant.socketPath,
        "rootfs",
        "/rootfs.ext4",
        true,
        config.firecracker.diskRateLimit,
      ),
    )
    .andThen(() =>
      fc.addDrive(
        tenant.socketPath,
        "overlay",
        "/overlay.ext4",
        false,
        config.firecracker.diskRateLimit,
      ),
    )
    .andThen(() =>
      fc.addNetworkInterface(
        tenant.socketPath,
        "eth0",
        tenant.tapDev,
        config.firecracker.networkRxRateLimit,
        config.firecracker.networkTxRateLimit,
      ),
    )
    .andThen(() => fc.startInstance(tenant.socketPath))
    .andThen(() => {
      actions.push("VM started successfully");
      return vsock.waitForAgent(
        tenant.ipAddress,
        config.vsock.agentPort,
        config.vsock.connectTimeoutMs,
      );
    })
    .andThen(() => {
      actions.push("Guest agent responded");
      return vsock.injectSecrets(
        tenant.ipAddress,
        config.vsock.agentPort,
        {
          OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
        },
        tenant.agentToken,
      );
    })
    .map(
      (): RepairResult => ({
        repair: "vm.process",
        fixed: true,
        actions,
      }),
    )
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: "vm.process",
        fixed: false,
        actions: [...actions, "Failed to restart VM"],
      }),
    );
}

export function repairVmResponsive(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<RepairResult, LobsterError> {
  return vsock
    .injectSecrets(
      tenant.ipAddress,
      config.vsock.agentPort,
      {
        OPENCLAW_GATEWAY_TOKEN: tenant.gatewayToken,
      },
      tenant.agentToken,
    )
    .map(
      (): RepairResult => ({
        repair: "vm.responsive",
        fixed: true,
        actions: ["Re-injected gateway token via TCP"],
      }),
    )
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: "vm.responsive",
        fixed: false,
        actions: ["Failed to re-inject secrets — VM may need full restart"],
      }),
    );
}
