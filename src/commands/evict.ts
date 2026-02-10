import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant, TenantRegistry } from '../types/index.js';
import { loadConfig, loadRegistry, saveRegistry } from '../config/loader.js';
import * as fc from '../system/firecracker.js';
import * as network from '../system/network.js';
import * as image from '../system/image.js';
import * as caddy from '../system/caddy.js';
import { exec } from '../system/exec.js';

export interface EvictProgress {
  step: string;
  detail: string;
}

export function runEvict(
  name: string,
  onProgress?: (p: EvictProgress) => void,
): ResultAsync<void, LobsterError> {
  const progress = (step: string, detail: string) => onProgress?.({ step, detail });
  let tenant: Tenant;
  let registry: TenantRegistry;

  return loadConfig().andThen((config) =>
    loadRegistry()
      .andThen((reg): ResultAsync<void, LobsterError> => {
        const found = reg.tenants.find((t) => t.name === name);
        if (!found) {
          return errAsync({ code: 'TENANT_NOT_FOUND', message: `Tenant "${name}" not found` });
        }
        tenant = found;
        registry = reg;

        found.status = 'removing';
        return saveRegistry(reg);
      })
      .andThen(() => {
        // Step 1: Remove Caddy route
        progress('caddy', 'Removing Caddy route');
        return caddy.removeRoute(config.caddy.adminApi, name)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 2: Send CtrlAltDel to VM, then SIGKILL if still alive
        progress('vm', 'Shutting down VM');
        return fc.sendCtrlAltDel(tenant.socketPath)
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
                  try { process.kill(tenant.vmPid, 'SIGKILL'); } catch {}
                }
              })(),
              () => ({ code: 'EXEC_FAILED' as const, message: 'Failed to stop VM' }),
            ),
          );
      })
      .andThen(() => {
        // Step 3: Delete TAP + remove NAT
        progress('network', `Deleting TAP ${tenant.tapDev} and NAT rules`);
        return network.removeNat(tenant.tapDev, tenant.ipAddress, tenant.gatewayPort)
          .orElse(() => okAsync(undefined))
          .andThen(() => network.deleteTap(tenant.tapDev));
      })
      .andThen(() => {
        // Step 4: Delete overlay file
        progress('overlay', `Deleting overlay ${tenant.overlayPath}`);
        return image.deleteOverlay(tenant.overlayPath)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 5: Clean up socket file
        progress('socket', `Cleaning up socket ${tenant.socketPath}`);
        return exec(['rm', '-f', tenant.socketPath, `${tenant.socketPath}.vsock`])
          .map(() => undefined)
          .orElse(() => okAsync(undefined));
      })
      .andThen(() => {
        // Step 6: Remove from registry
        progress('registry', 'Removing from registry');
        registry.tenants = registry.tenants.filter((t) => t.name !== name);
        return saveRegistry(registry);
      }),
  );
}
