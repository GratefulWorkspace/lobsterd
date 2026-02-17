import { render } from "ink";
import { useEffect, useState } from "react";
import { loadConfig, loadRegistry } from "../config/loader.js";
import type { Tenant, TenantWatchState } from "../types/index.js";
import { Dashboard } from "../ui/Dashboard.js";
import { startWatchdog } from "../watchdog/loop.js";
import { startScheduler } from "../watchdog/scheduler.js";

function WatchApp({
  tenants,
  handle,
}: {
  tenants: Tenant[];
  handle: ReturnType<typeof startWatchdog>;
}) {
  const [states, setStates] = useState<Record<string, TenantWatchState>>(
    handle.states(),
  );
  const [lastTick, setLastTick] = useState<string | null>(null);

  useEffect(() => {
    const unsub1 = handle.emitter.on("tick-complete", (data) => {
      setStates({ ...data.states });
      setLastTick(data.timestamp);
    });

    const unsub2 = handle.emitter.on("state-change", (_data) => {
      setStates((prev) => ({ ...prev }));
    });

    return () => {
      unsub1();
      unsub2();
    };
  }, [handle.emitter]);

  return <Dashboard tenants={tenants} states={states} lastTick={lastTick} />;
}

export async function runWatch(
  opts: { daemon?: boolean } = {},
): Promise<number> {
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

  const handle = startWatchdog(config, registry);
  const scheduler = startScheduler(
    config,
    registry,
    handle.emitter,
    handle.states,
  );

  if (opts.daemon) {
    // Daemon mode: log to console instead of TUI
    handle.emitter.on("state-change", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: ${data.from} → ${data.to}`,
      );
    });

    handle.emitter.on("repair-complete", (data) => {
      for (const r of data.results) {
        console.log(
          `[${new Date().toISOString()}] ${data.tenant} repair ${r.repair}: ${r.fixed ? "fixed" : "failed"}`,
        );
      }
    });

    handle.emitter.on("tick-complete", (data) => {
      const states = Object.entries(data.states)
        .map(([name, s]) => `${name}=${s.state}`)
        .join(", ");
      console.log(`[${data.timestamp}] tick: ${states}`);
    });

    handle.emitter.on("scheduler-poll", (data) => {
      const idle =
        data.idleFor !== null
          ? ` idle=${(data.idleFor / 1000).toFixed(1)}s`
          : "";
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: conn=${data.connections}${idle}`,
      );
    });

    handle.emitter.on("suspend-start", (data) => {
      console.log(`[${new Date().toISOString()}] ${data.tenant}: suspending`);
    });

    handle.emitter.on("suspend-complete", (data) => {
      const wake = data.nextWakeAtMs
        ? ` (next wake: ${new Date(data.nextWakeAtMs).toISOString()})`
        : "";
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: suspended${wake}`,
      );
    });

    handle.emitter.on("suspend-failed", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: suspend failed: ${data.error}`,
      );
    });

    handle.emitter.on("suspend-skipped", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: suspend skipped: ${data.reason}`,
      );
    });

    handle.emitter.on("resume-start", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: resuming (trigger: ${data.trigger})`,
      );
    });

    handle.emitter.on("resume-complete", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: resumed (PID ${data.vmPid})`,
      );
    });

    handle.emitter.on("resume-failed", (data) => {
      console.log(
        `[${new Date().toISOString()}] ${data.tenant}: resume failed: ${data.error}`,
      );
    });

    // Keep alive
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        scheduler.stop();
        handle.stop();
        resolve();
      });
      process.on("SIGTERM", () => {
        scheduler.stop();
        handle.stop();
        resolve();
      });
    });
    return 0;
  }

  // TUI mode
  const { waitUntilExit } = render(
    <WatchApp tenants={registry.tenants} handle={handle} />,
  );

  await waitUntilExit();
  scheduler.stop();
  handle.stop();
  return 0;
}
