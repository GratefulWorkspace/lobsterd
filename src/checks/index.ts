import { ResultAsync } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError, LobsterdConfig } from '../types/index.js';
import { runVmChecks } from './vm.js';
import { runNetworkChecks } from './network.js';

export function runAllChecks(tenant: Tenant, config: LobsterdConfig): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    runVmChecks(tenant),
    runNetworkChecks(tenant, config.caddy.adminApi),
  ]).map((groups) => groups.flat());
}

export function runQuickChecks(tenant: Tenant): ResultAsync<HealthCheckResult[], LobsterError> {
  return runVmChecks(tenant);
}
