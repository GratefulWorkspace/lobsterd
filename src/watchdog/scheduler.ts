import { okAsync } from "neverthrow";
import { runResume } from "../commands/resume.js";
import { runSuspend } from "../commands/suspend.js";
import { execUnchecked } from "../system/exec.js";
import * as vsock from "../system/vsock.js";
import type {
  ActiveConnectionsInfo,
  LobsterdConfig,
  Tenant,
  TenantRegistry,
  TenantWatchState,
} from "../types/index.js";
import type { WatchdogEmitter } from "./events.js";

export interface SchedulerHandle {
  stop: () => void;
}

interface SentinelHandle {
  stop: () => Promise<void>;
}

/** Guest port that Caddy dials into (hardcoded in caddy.addRoute) */
const GUEST_PORT = 9000;

/**
 * Start a TCP sentinel on the guest IP so Caddy's retry loop can reach it.
 * When a connection arrives, we know someone is trying to reach the suspended
 * VM and trigger a resume.
 */
async function startSentinel(
  tenant: Tenant,
  onWake: () => void,
): Promise<SentinelHandle> {
  let fired = false;
  const ip = tenant.ipAddress;
  const heldSockets = new Set<{ end(): void }>();

  // Add guest IP to loopback so the host can accept connections on it
  await execUnchecked(["ip", "addr", "add", `${ip}/32`, "dev", "lo"]);

  const server = Bun.listen({
    hostname: ip,
    port: GUEST_PORT,
    socket: {
      open(socket) {
        // Hold connection open — don't respond, don't close.
        // Caddy's request stays in-flight while resume happens.
        heldSockets.add(socket);
        if (!fired) {
          fired = true;
          onWake();
        }
      },
      data() {},
      close(socket) {
        heldSockets.delete(socket);
      },
      error() {},
    },
  });

  return {
    stop: async () => {
      server.stop(true);
      // Close held sockets — Caddy sees upstream failure and retries
      for (const s of heldSockets) {
        s.end();
      }
      heldSockets.clear();
      await execUnchecked(["ip", "addr", "del", `${ip}/32`, "dev", "lo"]);
    },
  };
}

export function startScheduler(
  config: LobsterdConfig,
  registry: TenantRegistry,
  emitter: WatchdogEmitter,
  getStates: () => Record<string, TenantWatchState>,
): SchedulerHandle {
  let running = true;

  // Track idle timestamps per tenant (first seen idle)
  const idleSince = new Map<string, number>();
  // Track cron wake timers
  const cronTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track sentinel listeners for suspended tenants
  const sentinels = new Map<string, SentinelHandle>();
  // Track in-flight operations to prevent races
  const inFlight = new Set<string>();

  function clearCronTimer(name: string) {
    const timer = cronTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      cronTimers.delete(name);
    }
  }

  async function stopSentinel(name: string) {
    const sentinel = sentinels.get(name);
    if (sentinel) {
      await sentinel.stop();
      sentinels.delete(name);
    }
  }

  async function startSentinelForTenant(tenant: Tenant) {
    if (sentinels.has(tenant.name)) {
      return;
    }
    const sentinel = await startSentinel(tenant, () => {
      triggerResume(tenant.name, "traffic");
    });
    sentinels.set(tenant.name, sentinel);
  }

  function scheduleCronWake(tenant: Tenant) {
    if (!tenant.suspendInfo?.nextWakeAtMs) {
      return;
    }
    clearCronTimer(tenant.name);

    const delay = tenant.suspendInfo.nextWakeAtMs - Date.now();
    if (delay <= 0) {
      // Already past wake time, resume immediately
      triggerResume(tenant.name, "cron");
      return;
    }

    const timer = setTimeout(() => {
      cronTimers.delete(tenant.name);
      if (running) {
        triggerResume(tenant.name, "cron");
      }
    }, delay);
    cronTimers.set(tenant.name, timer);
  }

  async function triggerResume(
    name: string,
    trigger: "traffic" | "cron" | "manual",
  ) {
    if (!running || inFlight.has(name)) {
      return;
    }
    inFlight.add(name);

    // Keep status as "suspended" during resume so the watchdog skips
    // health checks while the VM is still starting up.

    // Tear down sentinel before resume so the port is free for the real VM
    await stopSentinel(name);

    emitter.emit("resume-start", { tenant: name, trigger });
    const result = await runResume(name);
    if (result.isOk()) {
      // Sync full state from on-disk (this sets status to "active")
      const idx = registry.tenants.findIndex((t) => t.name === name);
      if (idx !== -1) {
        Object.assign(registry.tenants[idx], result.value);
      }
      emitter.emit("resume-complete", {
        tenant: name,
        vmPid: result.value.vmPid,
      });
      clearCronTimer(name);
      if (trigger === "cron") {
        // Poke cron via cron.run(mode:"due") to trigger overdue jobs and re-arm
        // the timer immediately, instead of waiting up to 60s for the stale
        // setTimeout clamp to expire after snapshot resume.
        // The agent defers each run to 5s after the job's nextRunAtMs,
        // giving OpenClaw's own timer a chance to fire naturally first.
        const idx = registry.tenants.findIndex((t) => t.name === name);
        if (idx !== -1) {
          await vsock
            .pokeCron(
              registry.tenants[idx].ipAddress,
              config.vsock.agentPort,
              registry.tenants[idx].agentToken,
            )
            .orElse(() => okAsync(undefined));
        }
        // Also poke heartbeat — writes marker if heartbeat is due,
        // preventing re-suspend during execution.
        const tenantRef = registry.tenants[idx];
        if (tenantRef) {
          await vsock
            .pokeHeartbeat(
              tenantRef.ipAddress,
              config.vsock.agentPort,
              tenantRef.agentToken,
            )
            .orElse(() => okAsync(undefined));
        }

        // Give the cron/heartbeat job time to start executing (runningAtMs
        // in jobs.json or /tmp/heartbeat-active counts as an active
        // connection and prevents re-suspend).
        idleSince.set(
          name,
          Date.now() + config.watchdog.cronWakeAheadMs + 5_000,
        );
      } else {
        idleSince.delete(name);
      }
    } else {
      emitter.emit("resume-failed", {
        tenant: name,
        error: result.error.message,
      });
    }
    inFlight.delete(name);
  }

  async function triggerSuspend(name: string) {
    if (!running || inFlight.has(name)) {
      return;
    }
    inFlight.add(name);

    // Mark suspended in-memory immediately so the watchdog skips health
    // checks and repairs while the VM is being snapshotted + killed
    const idx = registry.tenants.findIndex((t) => t.name === name);
    if (idx !== -1) {
      registry.tenants[idx].status = "suspended";
    }

    emitter.emit("suspend-start", { tenant: name });
    const result = await runSuspend(name);
    if (result.isOk()) {
      // Sync full state from on-disk
      if (idx !== -1) {
        Object.assign(registry.tenants[idx], result.value);
      }
      emitter.emit("suspend-complete", {
        tenant: name,
        nextWakeAtMs: result.value.suspendInfo?.nextWakeAtMs ?? null,
      });
      // Start sentinel for wake-on-request
      if (idx !== -1) {
        await startSentinelForTenant(registry.tenants[idx]);
        scheduleCronWake(registry.tenants[idx]);
      }
      idleSince.delete(name);
    } else if (result.error.code === "SUSPEND_SKIPPED") {
      // Cron wake too close — revert to active and reset idle tracking
      if (idx !== -1) {
        registry.tenants[idx].status = "active";
      }
      idleSince.delete(name);
      emitter.emit("suspend-skipped", {
        tenant: name,
        reason: result.error.message,
      });
    } else {
      // Revert in-memory status on failure
      if (idx !== -1) {
        registry.tenants[idx].status = "active";
      }
      // Reset idle timer so we don't immediately retry
      idleSince.delete(name);
      emitter.emit("suspend-failed", {
        tenant: name,
        error: result.error.message,
      });
    }
    inFlight.delete(name);
  }

  // ── Idle detection (auto-suspend) ────────────────────────────────────────
  const idleInterval = setInterval(async () => {
    if (!running) {
      return;
    }
    for (const tenant of registry.tenants) {
      if (tenant.status === "suspended") {
        // Ensure sentinel exists for suspended tenants (covers manual suspend)
        if (!sentinels.has(tenant.name) && !inFlight.has(tenant.name)) {
          await startSentinelForTenant(tenant);
        }
        idleSince.delete(tenant.name);
        continue;
      }
      if (tenant.status !== "active") {
        idleSince.delete(tenant.name);
        continue;
      }
      if (inFlight.has(tenant.name)) {
        continue;
      }

      // Don't poll or suspend if watchdog reports unhealthy — let repair finish.
      // Exclude SUSPENDED: after a cron resume the VM is active but the
      // watchdog state lags by one tick.  Clearing idleSince here would
      // destroy the negative-idle cron buffer set in triggerResume.
      const watchState = getStates()[tenant.name]?.state;
      if (
        watchState &&
        watchState !== "HEALTHY" &&
        watchState !== "UNKNOWN" &&
        watchState !== "SUSPENDED"
      ) {
        idleSince.delete(tenant.name);
        continue;
      }

      const connResult = await vsock.getActiveConnections(
        tenant.ipAddress,
        config.vsock.agentPort,
        tenant.agentToken,
      );
      const info: ActiveConnectionsInfo | null = connResult.isOk()
        ? connResult.value
        : null;
      const total = info ? info.tcp + info.cron + info.heartbeat : -1;

      if (total === 0) {
        const now = Date.now();
        if (!idleSince.has(tenant.name)) {
          idleSince.set(tenant.name, now);
        }
        const elapsed = now - (idleSince.get(tenant.name) ?? now);
        emitter.emit("scheduler-poll", {
          tenant: tenant.name,
          connections: info,
          idleFor: elapsed,
        });
        if (elapsed >= config.watchdog.idleThresholdMs) {
          triggerSuspend(tenant.name);
        }
      } else {
        emitter.emit("scheduler-poll", {
          tenant: tenant.name,
          connections: info,
          idleFor: null,
        });
        if (total > 0) {
          idleSince.delete(tenant.name);
        }
      }
      // info === null means agent unreachable, don't change idle tracking
    }
  }, config.watchdog.trafficPollMs);

  // ── Cleanup stale sentinel IPs + initialize for suspended tenants ────
  (async () => {
    for (const tenant of registry.tenants) {
      // Remove any stale loopback alias left by a crashed watchdog
      await execUnchecked([
        "ip",
        "addr",
        "del",
        `${tenant.ipAddress}/32`,
        "dev",
        "lo",
      ]);

      if (tenant.status === "suspended" && tenant.suspendInfo) {
        await startSentinelForTenant(tenant);
        scheduleCronWake(tenant);
      }
    }
  })();

  return {
    stop: () => {
      running = false;
      clearInterval(idleInterval);
      for (const timer of cronTimers.values()) {
        clearTimeout(timer);
      }
      cronTimers.clear();
      for (const [name] of sentinels) {
        stopSentinel(name);
      }
    },
  };
}
