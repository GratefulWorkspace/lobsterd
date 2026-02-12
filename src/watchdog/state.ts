import type {
  HealthCheckResult,
  TenantWatchState,
  WatchdogConfig,
} from "../types/index.js";

export function initialWatchState(): TenantWatchState {
  return {
    state: "UNKNOWN",
    lastCheck: null,
    lastResults: [],
    repairAttempts: 0,
    lastRepairAt: null,
  };
}

export function transition(
  current: TenantWatchState,
  checkResults: HealthCheckResult[],
  config: WatchdogConfig,
): { next: TenantWatchState; needsRepair: boolean } {
  const allOk = checkResults.every((r) => r.status === "ok");
  const _anyFailed = checkResults.some((r) => r.status === "failed");
  const now = new Date().toISOString();

  const base: TenantWatchState = {
    ...current,
    lastCheck: now,
    lastResults: checkResults,
  };

  switch (current.state) {
    case "UNKNOWN":
      if (allOk) {
        return {
          next: { ...base, state: "HEALTHY", repairAttempts: 0 },
          needsRepair: false,
        };
      }
      return { next: { ...base, state: "DEGRADED" }, needsRepair: true };

    case "HEALTHY":
      if (allOk) {
        return { next: { ...base, state: "HEALTHY" }, needsRepair: false };
      }
      return {
        next: { ...base, state: "DEGRADED", repairAttempts: 0 },
        needsRepair: true,
      };

    case "DEGRADED":
      if (allOk) {
        return {
          next: { ...base, state: "RECOVERING", repairAttempts: 0 },
          needsRepair: false,
        };
      }
      if (current.repairAttempts >= config.maxRepairAttempts) {
        return { next: { ...base, state: "FAILED" }, needsRepair: false };
      }
      return { next: { ...base, state: "DEGRADED" }, needsRepair: true };

    case "RECOVERING":
      if (allOk) {
        return {
          next: { ...base, state: "HEALTHY", repairAttempts: 0 },
          needsRepair: false,
        };
      }
      return {
        next: { ...base, state: "DEGRADED", repairAttempts: 0 },
        needsRepair: true,
      };

    case "FAILED":
      // Manual molt resets to DEGRADED; watchdog does not auto-repair FAILED
      if (allOk) {
        return {
          next: { ...base, state: "HEALTHY", repairAttempts: 0 },
          needsRepair: false,
        };
      }
      return { next: { ...base, state: "FAILED" }, needsRepair: false };

    case "SUSPENDED":
      // After resume, health checks run again — transition based on results
      if (allOk) {
        return {
          next: { ...base, state: "HEALTHY", repairAttempts: 0 },
          needsRepair: false,
        };
      }
      return { next: { ...base, state: "DEGRADED" }, needsRepair: true };

    default:
      return { next: base, needsRepair: false };
  }
}

export function resetToMolting(current: TenantWatchState): TenantWatchState {
  return {
    ...current,
    state: "DEGRADED",
    repairAttempts: 0,
    lastRepairAt: null,
  };
}
