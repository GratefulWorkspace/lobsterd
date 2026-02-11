import { ResultAsync } from "neverthrow";
import type {
  HealthCheckResult,
  LobsterdConfig,
  LobsterError,
  Tenant,
} from "../types/index.js";
import { runNetworkChecks } from "./network.js";
import { runVmChecks } from "./vm.js";

export function runAllChecks(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    runVmChecks(tenant, config.vsock.healthPort),
    runNetworkChecks(tenant, config.caddy.adminApi),
  ]).map((groups) => groups.flat());
}

export function runQuickChecks(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<HealthCheckResult[], LobsterError> {
  return runVmChecks(tenant, config.vsock.healthPort);
}
