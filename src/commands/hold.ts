import crypto from "node:crypto";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { runResume } from "../commands/resume.js";
import { loadConfig, loadRegistry } from "../config/loader.js";
import * as vsock from "../system/vsock.js";
import type { LobsterdConfig, LobsterError, Tenant } from "../types/index.js";

export const HOLD_TTL_MS = 5 * 60_000; // 5 minutes
export const KEEPALIVE_MS = 2 * 60_000; // 2 minutes

export interface HeldTenant {
  tenant: Tenant;
  config: LobsterdConfig;
  holdId: string;
  /** Re-acquire the hold (called automatically on an interval, but exposed for manual use). */
  keepalive: () => ResultAsync<void, LobsterError>;
  /** Release the hold and stop the keepalive interval. Always call when done. */
  release: () => Promise<void>;
}

/**
 * Resolve a tenant by name, auto-resume if suspended, acquire a hold, and
 * start a keepalive interval. Returns everything the caller needs to do work
 * and a `release()` they must call when finished.
 */
export function withHold(name: string): ResultAsync<HeldTenant, LobsterError> {
  return loadConfig().andThen((config) =>
    loadRegistry().andThen((registry) => {
      const tenant = registry.tenants.find((t) => t.name === name);
      if (!tenant) {
        return errAsync({
          code: "TENANT_NOT_FOUND" as const,
          message: `Tenant "${name}" not found`,
        });
      }

      if (tenant.status === "removing") {
        return errAsync({
          code: "VALIDATION_FAILED" as const,
          message: `Tenant "${name}" is being removed`,
        });
      }

      const resumeIfNeeded: ResultAsync<Tenant, LobsterError> =
        tenant.status === "suspended"
          ? runResume(name, (p) =>
              process.stderr.write(`  [${p.step}] ${p.detail}\n`),
            ).andThen((resumed) =>
              vsock
                .waitForAgent(resumed.ipAddress, config.vsock.agentPort, 10_000)
                .map(() => resumed),
            )
          : okAsync(tenant);

      return resumeIfNeeded.andThen((activeTenant) => {
        const holdId = crypto.randomUUID();
        const { ipAddress, agentToken } = activeTenant;
        const agentPort = config.vsock.agentPort;

        const doAcquire = () =>
          vsock
            .acquireHold(ipAddress, agentPort, agentToken, holdId, HOLD_TTL_MS)
            .orElse(() => okAsync(undefined))
            .map(() => undefined);

        const doRelease = async () => {
          clearInterval(interval);
          await vsock
            .releaseHold(ipAddress, agentPort, agentToken, holdId)
            .orElse(() => okAsync(undefined));
        };

        const interval = setInterval(() => {
          doAcquire();
        }, KEEPALIVE_MS);

        // Acquire the initial hold, then hand back the context
        return doAcquire().map(
          (): HeldTenant => ({
            tenant: activeTenant,
            config,
            holdId,
            keepalive: doAcquire,
            release: doRelease,
          }),
        );
      });
    }),
  );
}
