import { ResultAsync, ok, okAsync } from 'neverthrow';
import type { Tenant, HealthCheckResult, RepairResult, LobsterError, LobsterdConfig } from '../types/index.js';
import { repairVmProcess, repairVmResponsive } from './vm.js';
import { repairTap, repairCaddyRoute } from './network.js';

type RepairFn = (tenant: Tenant, config: LobsterdConfig) => ResultAsync<RepairResult, LobsterError>;

const REPAIR_MAP: Record<string, RepairFn[]> = {
  'vm.process': [repairVmProcess],
  'vm.responsive': [repairVmResponsive],
  'net.tap': [repairTap],
  'net.gateway': [repairVmProcess],
  'net.caddy-route': [repairCaddyRoute],
};

export function runRepairs(
  tenant: Tenant,
  failedChecks: HealthCheckResult[],
  config: LobsterdConfig,
): ResultAsync<RepairResult[], LobsterError> {
  const seen = new Set<Function>();
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
        fn(tenant, config)
          .map((result) => [...results, result])
          .orElse(() => ok([...results, { repair: 'unknown', fixed: false, actions: ['Repair threw an error'] }])),
      ),
    ResultAsync.fromSafePromise(Promise.resolve([])),
  );
}
