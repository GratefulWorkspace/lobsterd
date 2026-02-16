import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { loadConfig, loadRegistry, saveRegistry } from "../config/loader.js";
import { exec } from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import type {
  LobsterdConfig,
  LobsterError,
  Tenant,
  TenantRegistry,
} from "../types/index.js";

export interface ResumeProgress {
  step: string;
  detail: string;
}

export function runResume(
  name: string,
  onProgress?: (p: ResumeProgress) => void,
): ResultAsync<Tenant, LobsterError> {
  const progress = (step: string, detail: string) =>
    onProgress?.({ step, detail });

  let config: LobsterdConfig;
  let tenant: Tenant;
  let snapshotDir: string;
  let registry: TenantRegistry;
  let vmProcPid: number | null = null;

  return loadConfig()
    .andThen((c) => {
      config = c;
      return loadRegistry();
    })
    .andThen((reg): ResultAsync<void, LobsterError> => {
      const found = reg.tenants.find((t) => t.name === name);
      if (!found) {
        return errAsync({
          code: "TENANT_NOT_FOUND",
          message: `Tenant "${name}" not found`,
        });
      }
      if (found.status !== "suspended" || !found.suspendInfo) {
        return errAsync({
          code: "RESUME_FAILED",
          message: `Tenant "${name}" is not suspended (status: ${found.status})`,
        });
      }
      tenant = found;
      snapshotDir = found.suspendInfo.snapshotDir;
      registry = reg;
      return okAsync(undefined);
    })
    .andThen(() => {
      // Step 1: Clean stale jailer chroot
      progress("chroot", "Cleaning stale jailer chroot");
      return jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId);
    })
    .andThen(() => {
      // Step 2: Spawn new Firecracker via jailer
      progress("firecracker", "Starting Firecracker microVM via jailer");
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
          vmProcPid = proc.pid;
          await Bun.sleep(800);
        })(),
        (e): LobsterError => ({
          code: "RESUME_FAILED",
          message: `Failed to spawn jailer: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      );
    })
    .andThen(() => {
      // Step 3: Hard-link kernel, rootfs, overlay into new chroot
      progress("chroot", "Linking drive files into jailer chroot");
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
      // Step 4: Copy snapshot files INTO chroot and chown
      progress("snapshot", "Copying snapshot into chroot");
      const chrootRoot = jailer.getChrootRoot(
        config.jailer.chrootBaseDir,
        tenant.vmId,
      );
      return exec([
        "cp",
        "--sparse=always",
        `${snapshotDir}/snapshot_file`,
        `${chrootRoot}/snapshot_file`,
      ])
        .andThen(() =>
          exec([
            "cp",
            "--sparse=always",
            `${snapshotDir}/mem_file`,
            `${chrootRoot}/mem_file`,
          ]),
        )
        .andThen(() =>
          exec([
            "chown",
            `${tenant.jailUid}:${tenant.jailUid}`,
            `${chrootRoot}/snapshot_file`,
            `${chrootRoot}/mem_file`,
          ]),
        );
    })
    .andThen(() => {
      // Step 5: Load snapshot (VM resumes instantly)
      progress("resume", "Loading snapshot and resuming VM");
      return fc.loadSnapshot(tenant.socketPath, "/snapshot_file", "/mem_file");
    })
    .andThen(() => {
      // Step 5.5: Sync guest clock (stale after snapshot restore)
      progress("time-sync", "Syncing guest clock");
      return vsock
        .setGuestTime(
          tenant.ipAddress,
          config.vsock.agentPort,
          tenant.agentToken,
        )
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      // Step 5.6: Refresh cron schedules against corrected clock
      progress("cron-refresh", "Refreshing cron schedules");
      return vsock
        .getCronSchedules(
          tenant.ipAddress,
          config.vsock.agentPort,
          tenant.agentToken,
        )
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      // Step 6: Clean up snapshot files from persistent storage
      progress("cleanup", "Removing snapshot from persistent storage");
      return exec(["rm", "-rf", snapshotDir]).orElse(() =>
        okAsync({ exitCode: 0, stdout: "", stderr: "" }),
      );
    })
    .andThen(() => {
      // Step 7: Update registry
      progress("registry", "Updating registry");
      tenant.status = "active";
      tenant.vmPid = vmProcPid;
      tenant.suspendInfo = null;
      return saveRegistry(registry).map(() => tenant);
    });
}
