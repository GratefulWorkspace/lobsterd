import { ok, ResultAsync } from "neverthrow";
import type {
  HealthCheckResult,
  LobsterdConfig,
  LobsterError,
  RepairResult,
  Tenant,
  TenantRegistry,
} from "../types/index.js";
import { repairCaddyRoute, repairTap } from "./network.js";
import { repairVmProcess, repairVmResponsive } from "./vm.js";

type RepairFn = (
  tenant: Tenant,
  config: LobsterdConfig,
  registry: TenantRegistry,
) => ResultAsync<RepairResult, LobsterError>;

const REPAIR_MAP: Record<string, RepairFn[]> = {
  "vm.process": [repairVmProcess],
  "vm.responsive": [repairVmResponsive],
  "net.tap": [repairTap],
  "net.gateway": [repairVmResponsive],
  "net.caddy-route": [repairCaddyRoute],
};

export function runRepairs(
  tenant: Tenant,
  failedChecks: HealthCheckResult[],
  config: LobsterdConfig,
  registry: TenantRegistry,
): ResultAsync<RepairResult[], LobsterError> {
  const seen = new Set<RepairFn>();
  const repairFns: RepairFn[] = [];

  for (const check of failedChecks) {
    const repairs = REPAIR_MAP[check.check] ?? [];
    for (const fn of repairs) {
      if (!seen.has(fn)) {
        seen.add(fn);
        repairFns.push(fn);
      }
    }
  }

  if (repairFns.length === 0) {
    return ResultAsync.fromSafePromise(Promise.resolve([]));
  }

  return repairFns.reduce<ResultAsync<RepairResult[], LobsterError>>(
    (acc, fn) =>
      acc.andThen((results) =>
        fn(tenant, config, registry)
          .map((result) => [...results, result])
          .orElse(() =>
            ok([
              ...results,
              {
                repair: "unknown",
                fixed: false,
                actions: ["Repair threw an error"],
              },
            ]),
          ),
      ),
    ResultAsync.fromSafePromise(Promise.resolve([])),
  );
}
