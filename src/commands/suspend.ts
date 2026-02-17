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
  HeartbeatScheduleInfo,
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

/** Extract future run times from cron schedules (cron.list returns fresh data) */
function computeFutureRunTimes(
  schedules: CronScheduleInfo[],
  now: number,
): number[] {
  return schedules.filter((s) => s.nextRunAtMs > now).map((s) => s.nextRunAtMs);
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
  let heartbeatSchedule: HeartbeatScheduleInfo | null = null;
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
        // Step 1a: Fetch heartbeat schedule (soft-fail)
        progress("heartbeat", "Fetching heartbeat schedule from guest agent");
        return vsock
          .getHeartbeatSchedule(
            tenant.ipAddress,
            config.vsock.agentPort,
            tenant.agentToken,
          )
          .map((hb) => {
            heartbeatSchedule = hb;
            progress(
              "heartbeat",
              hb
                ? `Heartbeat: enabled=${hb.enabled} intervalMs=${hb.intervalMs} nextBeatAtMs=${hb.nextBeatAtMs} (in ${Math.round((hb.nextBeatAtMs - Date.now()) / 1000)}s)`
                : "Heartbeat: null (disabled or no config)",
            );
            return undefined;
          })
          .orElse((err) => {
            progress(
              "heartbeat",
              `Heartbeat fetch failed: ${err.code} ${err.message}`,
            );
            return okAsync(undefined);
          });
      })
      .andThen((): ResultAsync<void, LobsterError> => {
        // Step 1b: Early bail if next wake would be in the past
        const now = Date.now();
        const candidates: number[] = [];

        const futureRuns = computeFutureRunTimes(cronSchedules, now);
        if (futureRuns.length > 0) {
          candidates.push(Math.min(...futureRuns));
        }
        if (heartbeatSchedule?.enabled) {
          if (heartbeatSchedule.nextBeatAtMs > now) {
            candidates.push(heartbeatSchedule.nextBeatAtMs);
          } else {
            progress(
              "heartbeat",
              `Heartbeat nextBeatAtMs=${heartbeatSchedule.nextBeatAtMs} is in the PAST (now=${now}, delta=${Math.round((now - heartbeatSchedule.nextBeatAtMs) / 1000)}s ago) — not adding as wake candidate`,
            );
          }
        } else {
          progress(
            "heartbeat",
            `Heartbeat not adding candidate: schedule=${heartbeatSchedule ? `enabled=${heartbeatSchedule.enabled}` : "null"}`,
          );
        }

        if (candidates.length > 0) {
          const earliest = Math.min(...candidates);
          const nextWakeAtMs = earliest - config.watchdog.cronWakeAheadMs;
          if (nextWakeAtMs <= now) {
            return errAsync({
              code: "SUSPEND_SKIPPED",
              message: `Next wake is ${Math.round((earliest - now) / 1000)}s away (within ${config.watchdog.cronWakeAheadMs / 1000}s wake-ahead window), skipping suspend`,
            });
          }
        }
        return okAsync(undefined);
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

        // Step 9: Compute next wake time from cron + heartbeat schedules
        // (Step 1b already validated that this won't be in the past)
        const now = Date.now();
        let nextWakeAtMs: number | null = null;
        let hasCronWake = false;
        let hasHeartbeatWake = false;

        const futureRuns = computeFutureRunTimes(cronSchedules, now);
        if (futureRuns.length > 0) {
          hasCronWake = true;
        }
        if (
          heartbeatSchedule?.enabled &&
          heartbeatSchedule.nextBeatAtMs > now
        ) {
          hasHeartbeatWake = true;
        }

        const wakeCandidates: number[] = [];
        if (hasCronWake) {
          wakeCandidates.push(
            Math.min(...futureRuns) - config.watchdog.cronWakeAheadMs,
          );
        }
        if (hasHeartbeatWake && heartbeatSchedule) {
          wakeCandidates.push(
            heartbeatSchedule.nextBeatAtMs - config.watchdog.cronWakeAheadMs,
          );
        }
        if (wakeCandidates.length > 0) {
          nextWakeAtMs = Math.min(...wakeCandidates);
        }

        const wakeReason: SuspendInfo["wakeReason"] =
          hasCronWake && hasHeartbeatWake
            ? "cron+heartbeat"
            : hasCronWake
              ? "cron"
              : hasHeartbeatWake
                ? "heartbeat"
                : null;

        progress(
          "wake",
          `Wake decision: reason=${wakeReason} cronRuns=${futureRuns.length} heartbeat=${heartbeatSchedule ? `enabled=${heartbeatSchedule.enabled} nextBeat=${heartbeatSchedule.nextBeatAtMs}` : "null"} → nextWakeAtMs=${nextWakeAtMs}${nextWakeAtMs ? ` (in ${Math.round((nextWakeAtMs - now) / 1000)}s)` : " (NONE)"}`,
        );

        // Step 10: Update registry
        progress("registry", "Updating registry");
        const suspendInfo: SuspendInfo = {
          suspendedAt: new Date().toISOString(),
          snapshotDir,
          cronSchedules,
          nextWakeAtMs,
          wakeReason,
          lastRxBytes,
          heartbeatSchedule,
        };
        tenant.status = "suspended";
        tenant.vmPid = null;
        tenant.suspendInfo = suspendInfo;
        return saveRegistry(registry).map(() => tenant);
      }),
  );
}
