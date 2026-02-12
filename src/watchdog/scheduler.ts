import { readFileSync } from "node:fs";
import { runResume } from "../commands/resume.js";
import { runSuspend } from "../commands/suspend.js";
import * as vsock from "../system/vsock.js";
import type {
  LobsterdConfig,
  Tenant,
  TenantRegistry,
} from "../types/index.js";
import type { WatchdogEmitter } from "./events.js";

export interface SchedulerHandle {
  stop: () => void;
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

export function startScheduler(
  config: LobsterdConfig,
  registry: TenantRegistry,
  emitter: WatchdogEmitter,
): SchedulerHandle {
  let running = true;

  // Track idle timestamps per tenant (first seen idle)
  const idleSince = new Map<string, number>();
  // Track cron wake timers
  const cronTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track in-flight operations to prevent races
  const inFlight = new Set<string>();

  function clearCronTimer(name: string) {
    const timer = cronTimers.get(name);
    if (timer) {
      clearTimeout(timer);
      cronTimers.delete(name);
    }
  }

  function scheduleCronWake(tenant: Tenant) {
    if (!tenant.suspendInfo?.nextWakeAtMs) return;
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
    if (!running || inFlight.has(name)) return;
    inFlight.add(name);

    emitter.emit("resume-start", { tenant: name, trigger });
    const result = await runResume(name);
    if (result.isOk()) {
      emitter.emit("resume-complete", {
        tenant: name,
        vmPid: result.value.vmPid,
      });
      clearCronTimer(name);
      idleSince.delete(name);
    } else {
      emitter.emit("resume-failed", {
        tenant: name,
        error: result.error.message,
      });
    }
    inFlight.delete(name);
  }

  async function triggerSuspend(name: string) {
    if (!running || inFlight.has(name)) return;
    inFlight.add(name);

    emitter.emit("suspend-start", { tenant: name });
    const result = await runSuspend(name);
    if (result.isOk()) {
      emitter.emit("suspend-complete", {
        tenant: name,
        nextWakeAtMs: result.value.suspendInfo?.nextWakeAtMs ?? null,
      });
      // Schedule cron wake for newly suspended tenant
      const updated = registry.tenants.find((t) => t.name === name);
      if (updated) {
        scheduleCronWake(updated);
      }
      idleSince.delete(name);
    } else {
      emitter.emit("suspend-failed", {
        tenant: name,
        error: result.error.message,
      });
    }
    inFlight.delete(name);
  }

  // ── Traffic detection (wake-on-request) ──────────────────────────────────
  const trafficInterval = setInterval(() => {
    if (!running) return;
    for (const tenant of registry.tenants) {
      if (tenant.status !== "suspended" || !tenant.suspendInfo) continue;
      if (inFlight.has(tenant.name)) continue;

      const currentRx = readTapRxBytes(tenant.tapDev);
      if (currentRx > tenant.suspendInfo.lastRxBytes) {
        triggerResume(tenant.name, "traffic");
      }
    }
  }, config.watchdog.trafficPollMs);

  // ── Idle detection (auto-suspend) ────────────────────────────────────────
  const idleInterval = setInterval(async () => {
    if (!running) return;
    for (const tenant of registry.tenants) {
      if (tenant.status !== "active") {
        idleSince.delete(tenant.name);
        continue;
      }
      if (inFlight.has(tenant.name)) continue;

      const connResult = await vsock.getActiveConnections(
        tenant.ipAddress,
        config.vsock.agentPort,
        tenant.agentToken,
      );
      const connections = connResult.isOk() ? connResult.value : -1;

      if (connections === 0) {
        const now = Date.now();
        if (!idleSince.has(tenant.name)) {
          idleSince.set(tenant.name, now);
        }
        const idleMs = now - idleSince.get(tenant.name)!;
        if (idleMs >= config.watchdog.idleThresholdMs) {
          triggerSuspend(tenant.name);
        }
      } else if (connections > 0) {
        idleSince.delete(tenant.name);
      }
      // connections === -1 means agent unreachable, don't change idle tracking
    }
  }, config.watchdog.intervalMs);

  // ── Initialize cron timers for already-suspended tenants ─────────────────
  for (const tenant of registry.tenants) {
    if (tenant.status === "suspended" && tenant.suspendInfo) {
      scheduleCronWake(tenant);
    }
  }

  return {
    stop: () => {
      running = false;
      clearInterval(trafficInterval);
      clearInterval(idleInterval);
      for (const timer of cronTimers.values()) {
        clearTimeout(timer);
      }
      cronTimers.clear();
    },
  };
}
