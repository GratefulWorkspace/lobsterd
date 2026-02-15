import { readFileSync } from "node:fs";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { SNAPSHOTS_DIR } from "../config/defaults.js";
import { loadConfig, loadRegistry, saveRegistry } from "../config/loader.js";
import { exec } from "../system/exec.js";
import * as fc from "../system/firecracker.js";
import * as jailer from "../system/jailer.js";
import * as vsock from "../system/vsock.js";
import type {
  CronScheduleInfo,
  LobsterError,
  SuspendInfo,
  Tenant,
  TenantRegistry,
} from "../types/index.js";

export interface SuspendProgress {
  step: string;
  detail: string;
}

function readTapRxBytes(tapDev: string): number {
  try {
    const raw = readFileSync(
      `/sys/class/net/${tapDev}/statistics/rx_bytes`,
      "utf-8",
    );
    return parseInt(raw.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function runSuspend(
  name: string,
  onProgress?: (p: SuspendProgress) => void,
): ResultAsync<Tenant, LobsterError> {
  const progress = (step: string, detail: string) =>
    onProgress?.({ step, detail });

  let tenant: Tenant;
  let registry: TenantRegistry;
  let cronSchedules: CronScheduleInfo[] = [];
  let snapshotDir: string;

  return loadConfig().andThen((config) =>
    loadRegistry()
      .andThen((reg): ResultAsync<void, LobsterError> => {
        const found = reg.tenants.find((t) => t.name === name);
        if (!found) {
          return errAsync({
            code: "TENANT_NOT_FOUND",
            message: `Tenant "${name}" not found`,
          });
        }
        if (found.status !== "active") {
          return errAsync({
            code: "SUSPEND_FAILED",
            message: `Tenant "${name}" is not active (status: ${found.status})`,
          });
        }
        tenant = found;
        registry = reg;
        snapshotDir = `${SNAPSHOTS_DIR}/${name}`;
        return okAsync(undefined);
      })
      .andThen(() => {
        // Step 1: Fetch cron schedules (soft-fail)
        progress("cron", "Fetching cron schedules from guest agent");
        return vsock
          .getCronSchedules(
            tenant.ipAddress,
            config.vsock.agentPort,
            tenant.agentToken,
          )
          .map((schedules) => {
            cronSchedules = schedules;
            return undefined;
          })
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 2: Record TAP rx_bytes
        progress("tap", "Recording TAP rx_bytes counter");
        const lastRxBytes = readTapRxBytes(tenant.tapDev);

        // Step 3: Pause VM
        progress("pause", "Pausing VM");
        return fc.pauseVm(tenant.socketPath).map(() => lastRxBytes);
      })
      .andThen((lastRxBytes) => {
        // Step 4: Create snapshot
        progress("snapshot", "Creating VM snapshot");
        return fc
          .createSnapshot(tenant.socketPath, "/snapshot_file", "/mem_file")
          .map(() => lastRxBytes);
      })
      .andThen((lastRxBytes) => {
        // Step 5: Copy snapshot files to persistent storage
        progress("copy", `Copying snapshot to ${snapshotDir}`);
        const chrootRoot = jailer.getChrootRoot(
          config.jailer.chrootBaseDir,
          tenant.vmId,
        );
        return exec(["mkdir", "-p", snapshotDir])
          .andThen(() =>
            exec([
              "cp",
              "--sparse=always",
              `${chrootRoot}/snapshot_file`,
              `${snapshotDir}/snapshot_file`,
            ]),
          )
          .andThen(() =>
            exec([
              "cp",
              "--sparse=always",
              `${chrootRoot}/mem_file`,
              `${snapshotDir}/mem_file`,
            ]),
          )
          .map(() => lastRxBytes);
      })
      .andThen((lastRxBytes) => {
        // Step 6: Kill Firecracker process
        progress("kill", "Stopping Firecracker process");
        if (tenant.vmPid) {
          try {
            process.kill(tenant.vmPid, "SIGKILL");
          } catch {
            // Already dead
          }
        }

        // Step 7: Clean up jailer chroot
        progress("chroot", "Cleaning up jailer chroot");
        return jailer
          .cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId)
          .map(() => lastRxBytes);
      })
      .andThen(() => {
        // Step 8: Re-read TAP rx_bytes now that the VM is dead,
        // so the baseline includes trailing TCP teardown / ARP chatter
        const lastRxBytes = readTapRxBytes(tenant.tapDev);

        // Step 9: Compute next wake time from cron schedules
        const now = Date.now();
        const futureSchedules = cronSchedules.filter(
          (s) => s.nextRunAtMs > now,
        );
        let nextWakeAtMs: number | null = null;
        if (futureSchedules.length > 0) {
          const earliest = Math.min(
            ...futureSchedules.map((s) => s.nextRunAtMs),
          );
          nextWakeAtMs = earliest - config.watchdog.cronWakeAheadMs;
        }

        // Step 10: Update registry
        progress("registry", "Updating registry");
        const suspendInfo: SuspendInfo = {
          suspendedAt: new Date().toISOString(),
          snapshotDir,
          cronSchedules,
          nextWakeAtMs,
          lastRxBytes,
        };
        tenant.status = "suspended";
        tenant.vmPid = null;
        tenant.suspendInfo = suspendInfo;
        return saveRegistry(registry).map(() => tenant);
      }),
  );
}
