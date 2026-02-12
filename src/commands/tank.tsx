import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { runAllChecks } from "../checks/index.js";
import { loadConfig, loadRegistry } from "../config/loader.js";
import * as vsock from "../system/vsock.js";
import type {
  LobsterdConfig,
  Tenant,
  TenantWatchState,
} from "../types/index.js";
import type { TenantExtraInfo } from "../ui/Dashboard.js";
import { Dashboard } from "../ui/Dashboard.js";
import { initialWatchState, transition } from "../watchdog/state.js";
import { buildTankEntries, quickPidCheck } from "./tank-data.js";

function TankApp({
  tenants,
  config,
}: {
  tenants: Tenant[];
  config: LobsterdConfig;
}) {
  const [states, setStates] = useState<Record<string, TenantWatchState>>(() => {
    const s: Record<string, TenantWatchState> = {};
    for (const t of tenants) {
      s[t.name] = initialWatchState();
    }
    return s;
  });
  const [extraInfo, setExtraInfo] = useState<Record<string, TenantExtraInfo>>(
    {},
  );
  const [lastTick, setLastTick] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const extras: Record<string, TenantExtraInfo> = {};

      for (const tenant of tenants) {
        if (cancelled) {
          break;
        }

        if (tenant.status === "suspended") {
          setStates((prev) => ({
            ...prev,
            [tenant.name]: {
              ...initialWatchState(),
              state: "SUSPENDED" as const,
              lastCheck: new Date().toISOString(),
            },
          }));
          extras[tenant.name] = {
            ip: tenant.ipAddress,
            vmPid: "suspended",
          };
          continue;
        }

        const result = await runAllChecks(tenant, config);
        if (result.isOk() && !cancelled) {
          setStates((prev) => {
            const current = prev[tenant.name] ?? initialWatchState();
            const { next } = transition(current, result.value, config.watchdog);
            return { ...prev, [tenant.name]: next };
          });
        }

        const pidStatus = quickPidCheck(tenant);
        const info: TenantExtraInfo = {
          ip: tenant.ipAddress,
          vmPid: pidStatus,
        };

        if (pidStatus !== "dead") {
          const stats = await vsock
            .getStats(
              tenant.ipAddress,
              config.vsock.agentPort,
              tenant.agentToken,
            )
            .unwrapOr(undefined);
          if (stats && stats.memoryKb > 0) {
            info.memoryMb = Math.round(stats.memoryKb / 1024);
          }
        }

        extras[tenant.name] = info;
      }

      if (!cancelled) {
        setExtraInfo(extras);
        setLastTick(new Date().toISOString());
        setChecking(false);
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, [config, tenants]);

  if (checking) {
    return (
      <Box padding={1}>
        <Text>Checking tenant health...</Text>
      </Box>
    );
  }

  return (
    <Dashboard
      tenants={tenants}
      states={states}
      lastTick={lastTick}
      extraInfo={extraInfo}
    />
  );
}

export async function runTank(opts?: { json?: boolean }): Promise<number> {
  const configResult = await loadConfig();
  if (configResult.isErr()) {
    console.error(`Error: ${configResult.error.message}`);
    return 1;
  }
  const config = configResult.value;

  const registryResult = await loadRegistry();
  if (registryResult.isErr()) {
    console.error(`Error: ${registryResult.error.message}`);
    return 1;
  }
  const registry = registryResult.value;

  if (registry.tenants.length === 0) {
    if (opts?.json) {
      console.log("[]");
    } else {
      console.log(
        "No tenants registered. Use `lobster spawn <name>` to add one.",
      );
    }
    return 0;
  }

  if (opts?.json) {
    const entries = await buildTankEntries(registry.tenants, config);
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  const { waitUntilExit } = render(
    <TankApp tenants={registry.tenants} config={config} />,
  );

  await waitUntilExit();
  return 0;
}
