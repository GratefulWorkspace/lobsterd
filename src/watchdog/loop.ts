import { runAllChecks } from "../checks/index.js";
import { loadRegistry } from "../config/loader.js";
import { runRepairs } from "../repair/index.js";
import type {
  LobsterdConfig,
  TenantRegistry,
  TenantWatchState,
} from "../types/index.js";
import { WatchdogEmitter } from "./events.js";
import { initialWatchState, transition } from "./state.js";

export interface WatchdogHandle {
  emitter: WatchdogEmitter;
  stop: () => void;
  states: () => Record<string, TenantWatchState>;
}

export function startWatchdog(
  config: LobsterdConfig,
  registry: TenantRegistry,
  inFlight: Set<string>,
): WatchdogHandle {
  const emitter = new WatchdogEmitter();
  const tenantStates: Record<string, TenantWatchState> = {};
  let running = true;
  let tickInProgress = false;

  // Initialize states
  for (const tenant of registry.tenants) {
    tenantStates[tenant.name] = initialWatchState();
  }

  async function tick() {
    if (!running || tickInProgress) {
      return;
    }
    tickInProgress = true;

    try {
      // Reload registry from disk so out-of-band CLI commands
      // (manual suspend/resume/evict) are picked up immediately
      const freshResult = await loadRegistry();
      if (freshResult.isOk()) {
        const fresh = freshResult.value;

        // Update existing tenants from disk
        for (const freshTenant of fresh.tenants) {
          if (inFlight.has(freshTenant.name)) {
            continue;
          }
          const idx = registry.tenants.findIndex(
            (t) => t.name === freshTenant.name,
          );
          if (idx !== -1) {
            Object.assign(registry.tenants[idx], freshTenant);
          }
        }

        // Add newly spawned tenants
        for (const freshTenant of fresh.tenants) {
          if (!registry.tenants.some((t) => t.name === freshTenant.name)) {
            registry.tenants.push(freshTenant);
            tenantStates[freshTenant.name] = initialWatchState();
          }
        }

        // Remove evicted tenants (skip in-flight)
        for (let i = registry.tenants.length - 1; i >= 0; i--) {
          const name = registry.tenants[i].name;
          if (inFlight.has(name)) {
            continue;
          }
          if (!fresh.tenants.some((t) => t.name === name)) {
            registry.tenants.splice(i, 1);
            delete tenantStates[name];
          }
        }
      }

      for (const tenant of registry.tenants) {
        if (!running) {
          break;
        }
        if (tenant.status === "removing" || inFlight.has(tenant.name)) {
          continue;
        }
        if (tenant.status === "suspended") {
          const oldState = (tenantStates[tenant.name] ?? initialWatchState())
            .state;
          if (oldState !== "SUSPENDED") {
            tenantStates[tenant.name] = {
              ...initialWatchState(),
              state: "SUSPENDED",
              lastCheck: new Date().toISOString(),
            };
            emitter.emit("state-change", {
              tenant: tenant.name,
              from: oldState,
              to: "SUSPENDED",
            });
          }
          continue;
        }

        const current = tenantStates[tenant.name] ?? initialWatchState();

        // Check cooldown
        if (current.lastRepairAt) {
          const elapsed = Date.now() - new Date(current.lastRepairAt).getTime();
          if (elapsed < config.watchdog.repairCooldownMs) {
            continue;
          }
        }

        // Run checks
        const checksResult = await runAllChecks(tenant, config);
        if (checksResult.isErr()) {
          continue;
        }

        const checkResults = checksResult.value;
        emitter.emit("check-complete", {
          tenant: tenant.name,
          results: checkResults,
        });

        const oldState = current.state;
        const { next, needsRepair } = transition(
          current,
          checkResults,
          config.watchdog,
        );
        tenantStates[tenant.name] = next;

        if (oldState !== next.state) {
          emitter.emit("state-change", {
            tenant: tenant.name,
            from: oldState,
            to: next.state,
          });
        }

        if (needsRepair) {
          // Re-check in-memory status — the scheduler may have marked
          // the tenant suspended after health checks started
          if (tenant.status !== "active") {
            continue;
          }

          // Re-check on-disk status before repairing — a manual suspend/resume
          // may have started after the tick began, making repairs dangerous
          const preRepairCheck = await loadRegistry();
          if (preRepairCheck.isOk()) {
            const diskTenant = preRepairCheck.value.tenants.find(
              (t) => t.name === tenant.name,
            );
            if (diskTenant && diskTenant.status !== "active") {
              Object.assign(tenant, diskTenant);
              continue;
            }
          }

          const failed = checkResults.filter((c) => c.status !== "ok");
          emitter.emit("repair-start", { tenant: tenant.name, checks: failed });

          const repairResult = await runRepairs(
            tenant,
            failed,
            config,
            registry,
          );
          if (repairResult.isOk()) {
            emitter.emit("repair-complete", {
              tenant: tenant.name,
              results: repairResult.value,
            });
            tenantStates[tenant.name] = {
              ...tenantStates[tenant.name],
              repairAttempts: tenantStates[tenant.name].repairAttempts + 1,
              lastRepairAt: new Date().toISOString(),
            };
          }
        }
      }

      emitter.emit("tick-complete", {
        timestamp: new Date().toISOString(),
        states: { ...tenantStates },
      });
    } finally {
      tickInProgress = false;
    }
  }

  const interval = setInterval(tick, config.watchdog.intervalMs);
  // Run first tick immediately
  tick();

  return {
    emitter,
    stop: () => {
      running = false;
      clearInterval(interval);
      emitter.removeAllListeners();
    },
    states: () => ({ ...tenantStates }),
  };
}
