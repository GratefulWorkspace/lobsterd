import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { loadConfig, loadRegistry, saveRegistry } from "../config/loader.js";
import * as caddy from "../system/caddy.js";
import * as fc from "../system/firecracker.js";
import * as image from "../system/image.js";
import * as jailer from "../system/jailer.js";
import * as network from "../system/network.js";
import * as ssh from "../system/ssh.js";
import type { LobsterError, Tenant, TenantRegistry } from "../types/index.js";

export interface EvictProgress {
  step: string;
  detail: string;
}

export function runEvict(
  name: string,
  onProgress?: (p: EvictProgress) => void,
): ResultAsync<void, LobsterError> {
  const progress = (step: string, detail: string) =>
    onProgress?.({ step, detail });
  let tenant: Tenant;
  let registry: TenantRegistry;

  return loadConfig().andThen((config) =>
    loadRegistry()
      .andThen((reg): ResultAsync<void, LobsterError> => {
        const found = reg.tenants.find((t) => t.name === name);
        if (!found) {
          return errAsync({
            code: "TENANT_NOT_FOUND",
            message: `Tenant "${name}" not found`,
          });
        }
        tenant = found;
        registry = reg;

        found.status = "removing";
        return saveRegistry(reg);
      })
      .andThen(() => {
        // Step 1: Remove Caddy route
        progress("caddy", "Removing Caddy route");
        return caddy
          .removeRoute(config.caddy.adminApi, name)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 2: Send CtrlAltDel to VM, then SIGKILL if still alive
        progress("vm", "Shutting down VM");
        return fc
          .sendCtrlAltDel(tenant.socketPath)
          .orElse(() => okAsync(undefined))
          .andThen(() =>
            ResultAsync.fromPromise(
              (async () => {
                // Wait up to 5 seconds for graceful shutdown
                if (tenant.vmPid) {
                  for (let i = 0; i < 10; i++) {
                    try {
                      process.kill(tenant.vmPid, 0);
                    } catch {
                      return; // Process is dead
                    }
                    await Bun.sleep(500);
                  }
                  // Force kill
                  try {
                    process.kill(tenant.vmPid, "SIGKILL");
                  } catch {}
                }
              })(),
              () => ({
                code: "EXEC_FAILED" as const,
                message: "Failed to stop VM",
              }),
            ),
          );
      })
      .andThen(() => {
        // Step 3: Remove network isolation rules
        progress("isolation", "Removing network isolation rules");
        return network
          .removeIsolationRules(tenant.tapDev)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 3b: Remove agent lockdown rules (if enabled)
        if (config.buoy?.agentLockdown) {
          progress("lockdown", "Removing agent lockdown rules");
          return network
            .removeAgentLockdownRules(
              tenant.ipAddress,
              config.vsock.agentPort,
              config.vsock.healthPort,
            )
            .orElse(() => okAsync(undefined));
        }
        return okAsync(undefined);
      })
      .andThen(() => {
        // Step 4: Delete TAP + remove NAT
        progress("network", `Deleting TAP ${tenant.tapDev} and NAT rules`);
        return network
          .removeNat(tenant.tapDev, tenant.ipAddress, tenant.gatewayPort)
          .orElse(() => okAsync(undefined))
          .andThen(() => network.deleteTap(tenant.tapDev));
      })
      .andThen(() => {
        // Step 5: Clean up jailer chroot
        progress("chroot", "Removing jailer chroot");
        return jailer.cleanupChroot(config.jailer.chrootBaseDir, tenant.vmId);
      })
      .andThen(() => {
        // Step 6: Delete overlay file
        progress("overlay", `Deleting overlay ${tenant.overlayPath}`);
        return image
          .deleteOverlay(tenant.overlayPath)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 6b: Remove SSH keypair
        progress("ssh", "Removing SSH keypair");
        return ssh.removeKeypair(tenant.name);
      })
      .andThen(() => {
        // Step 7: Remove from registry
        progress("registry", "Removing from registry");
        registry.tenants = registry.tenants.filter((t) => t.name !== name);
        return saveRegistry(registry);
      }),
  );
}
