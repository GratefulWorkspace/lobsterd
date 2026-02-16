import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { runAllChecks } from "../checks/index.js";
import { loadConfig, loadRegistry } from "../config/loader.js";
import { runRepairs } from "../repair/index.js";
import type {
  HealthCheckResult,
  LobsterError,
  RepairResult,
  Tenant,
} from "../types/index.js";

export interface MoltTenantResult {
  tenant: string;
  initialChecks: HealthCheckResult[];
  repairs: RepairResult[];
  finalChecks: HealthCheckResult[];
  healthy: boolean;
}

export interface MoltProgress {
  tenant: string;
  phase: "checking" | "repairing" | "verifying" | "done";
  detail?: string;
}

export function runMolt(
  name?: string,
  onProgress?: (p: MoltProgress) => void,
): ResultAsync<MoltTenantResult[], LobsterError> {
  const progress = (
    tenant: string,
    phase: MoltProgress["phase"],
    detail?: string,
  ) => onProgress?.({ tenant, phase, detail });

  return loadConfig().andThen((config) =>
    loadRegistry().andThen(
      (registry): ResultAsync<MoltTenantResult[], LobsterError> => {
        let tenants: Tenant[];
        if (name) {
          const found = registry.tenants.find((t) => t.name === name);
          if (!found) {
            return errAsync({
              code: "TENANT_NOT_FOUND",
              message: `Tenant "${name}" not found`,
            });
          }
          tenants = [found];
        } else {
          tenants = registry.tenants.filter((t) => t.status === "active");
        }

        if (tenants.length === 0) {
          return okAsync([]);
        }

        return tenants.reduce<ResultAsync<MoltTenantResult[], LobsterError>>(
          (acc, tenant) =>
            acc.andThen((results) => {
              progress(tenant.name, "checking");
              return runAllChecks(tenant, config)
                .andThen(
                  (
                    initialChecks,
                  ): ResultAsync<MoltTenantResult, LobsterError> => {
                    const failed = initialChecks.filter(
                      (c) => c.status !== "ok",
                    );
                    if (failed.length === 0) {
                      progress(tenant.name, "done", "Already healthy");
                      return okAsync({
                        tenant: tenant.name,
                        initialChecks,
                        repairs: [],
                        finalChecks: initialChecks,
                        healthy: true,
                      });
                    }

                    progress(
                      tenant.name,
                      "repairing",
                      `${failed.length} issue(s) found`,
                    );
                    return runRepairs(tenant, failed, config, registry).andThen(
                      (repairs) => {
                        progress(tenant.name, "verifying");
                        return runAllChecks(tenant, config).map(
                          (finalChecks) => ({
                            tenant: tenant.name,
                            initialChecks,
                            repairs,
                            finalChecks,
                            healthy: finalChecks.every(
                              (c) => c.status === "ok",
                            ),
                          }),
                        );
                      },
                    );
                  },
                )
                .map((result) => {
                  progress(
                    tenant.name,
                    "done",
                    result.healthy ? "Healthy" : "Still degraded",
                  );
                  return [...results, result];
                });
            }),
          okAsync<MoltTenantResult[], LobsterError>([]),
        );
      },
    ),
  );
}
