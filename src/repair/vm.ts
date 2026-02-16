import { okAsync, ResultAsync } from "neverthrow";
import { saveRegistry } from "../config/loader.js";
import { execUnchecked } from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import type {
  LobsterdConfig,
  LobsterError,
  RepairResult,
  Tenant,
  TenantRegistry,
} from "../types/index.js";

export function repairVmProcess(
  tenant: Tenant,
  config: LobsterdConfig,
  registry: TenantRegistry,
): ResultAsync<RepairResult, LobsterError> {
  const actions: string[] = [];

  // Kill ALL firecracker processes for this vmId (not just the recorded PID)
  // to prevent zombie processes from previous repair cycles hijacking the API socket
  return ResultAsync.fromSafePromise(
    (async () => {
      if (tenant.vmPid) {
        try {
          process.kill(tenant.vmPid, "SIGKILL");
        } catch {}
        actions.push(`Killed recorded VM process ${tenant.vmPid}`);
      }
      // Also kill any orphaned firecracker processes for the same VM ID
      await execUnchecked(["pkill", "-9", "-f", `--id ${tenant.vmId}`]);
      await Bun.sleep(200);
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
    .andThen(() => {
      actions.push("Secrets injected");
      // Persist updated vmPid to disk so subsequent ticks don't see stale state
      return saveRegistry(registry).map(
        (): RepairResult => ({
          repair: "vm.process",
          fixed: true,
          actions: [...actions, "Registry saved"],
        }),
      );
    })
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
    .ensureGateway(tenant.ipAddress, config.vsock.agentPort, tenant.agentToken)
    .map(
      (): RepairResult => ({
        repair: "vm.responsive",
        fixed: true,
        actions: ["Ensured gateway is running"],
      }),
    )
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: "vm.responsive",
        fixed: false,
        actions: ["Failed to ensure gateway — VM may need full restart"],
      }),
    );
}
