import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { runAllChecks } from "../checks/index.js";
import { loadConfig, loadRegistry } from "../config/loader.js";
import type {
  LobsterdConfig,
  Tenant,
  TenantWatchState,
} from "../types/index.js";
import { Dashboard } from "../ui/Dashboard.js";
import { initialWatchState, transition } from "../watchdog/state.js";

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
  const [lastTick, setLastTick] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      for (const tenant of tenants) {
        if (cancelled) {
          break;
        }
        const result = await runAllChecks(tenant, config);
        if (result.isOk() && !cancelled) {
          setStates((prev) => {
            const current = prev[tenant.name] ?? initialWatchState();
            const { next } = transition(current, result.value, config.watchdog);
            return { ...prev, [tenant.name]: next };
          });
        }
      }
      if (!cancelled) {
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

  return <Dashboard tenants={tenants} states={states} lastTick={lastTick} />;
}

export async function runTank(): Promise<number> {
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
    console.log(
      "No tenants registered. Use `lobster spawn <name>` to add one.",
    );
    return 0;
  }

  const { waitUntilExit } = render(
    <TankApp tenants={registry.tenants} config={config} />,
  );

  await waitUntilExit();
  return 0;
}
