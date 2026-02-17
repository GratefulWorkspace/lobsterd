import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { CONFIG_DIR, LOBSTERD_BASE } from "../config/defaults.js";
import { loadRegistry } from "../config/loader.js";
import { exec } from "../system/exec.js";
import * as network from "../system/network.js";
import * as systemd from "../system/systemd.js";
import type { LobsterError } from "../types/index.js";

export interface UninitProgress {
  step: string;
  detail: string;
}

export function runUninit(
  onProgress?: (p: UninitProgress) => void,
): ResultAsync<void, LobsterError> {
  const progress = (step: string, detail: string) =>
    onProgress?.({ step, detail });

  // Step 1: Check registry — refuse if tenants still exist
  return loadRegistry()
    .andThen((reg): ResultAsync<void, LobsterError> => {
      if (reg.tenants.length > 0) {
        const names = reg.tenants.map((t) => t.name).join(", ");
        return errAsync({
          code: "VALIDATION_FAILED",
          message: `Cannot uninit: ${reg.tenants.length} tenant(s) still exist (${names}). Evict all tenants first.`,
        });
      }
      return okAsync(undefined);
    })
    .andThen(() => {
      // Step 2: Stop and remove watchdog service
      progress("services", "Stopping lobsterd-watch service");
      return systemd
        .stopAndRemoveService("lobsterd-watch")
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      // Step 3: Flush and remove iptables chains
      progress("iptables", "Flushing LOBSTER iptables chains");
      return network.flushAndRemoveChains().orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      // Step 4: Remove /var/lib/lobsterd/
      progress("data", `Removing ${LOBSTERD_BASE}`);
      return exec(["rm", "-rf", LOBSTERD_BASE])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      // Step 5: Remove /etc/lobsterd/
      progress("config", `Removing ${CONFIG_DIR}`);
      return exec(["rm", "-rf", CONFIG_DIR])
        .map(() => undefined)
        .orElse(() => okAsync(undefined));
    });
}
