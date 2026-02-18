import { render, useApp, useInput } from "ink";
import { useEffect, useState } from "react";
import { fetchLogs } from "../system/logs.js";
import type { Tenant } from "../types/index.js";
import { LogStream } from "../ui/LogStream.js";
import { withHold } from "./hold.js";

export async function runWatchdogLogs(): Promise<number> {
  const proc = Bun.spawn(
    ["journalctl", "-u", "lobsterd-watch", "-f", "-n", "100", "--no-pager"],
    {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    },
  );

  process.on("SIGINT", () => proc.kill());
  process.on("SIGTERM", () => proc.kill());

  await proc.exited;
  return 0;
}

function LogsApp({
  tenant,
  agentPort,
  service,
}: {
  tenant: Tenant;
  agentPort: number;
  service?: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const { exit } = useApp();

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  });

  useEffect(() => {
    let cancelled = false;

    async function pollLogs() {
      while (!cancelled) {
        try {
          const logs = await fetchLogs(
            tenant.ipAddress,
            agentPort,
            tenant.agentToken,
            service,
          );
          if (logs) {
            const parts = logs.split("\n").filter(Boolean);
            setLines(parts);
          }
        } catch {
          // Agent not reachable, retry
        }
        await Bun.sleep(3000);
      }
    }

    pollLogs();
    return () => {
      cancelled = true;
    };
  }, [agentPort, service, tenant.agentToken, tenant.ipAddress]);

  return (
    <LogStream
      title={`${tenant.name} — ${service || "gateway"} logs`}
      lines={lines}
    />
  );
}

export async function runLogs(
  name: string,
  opts: { service?: string } = {},
): Promise<number> {
  const holdResult = await withHold(name);
  if (holdResult.isErr()) {
    console.error(`Error: ${holdResult.error.message}`);
    return 1;
  }
  const { tenant, config, release } = holdResult.value;

  try {
    if (!process.stdin.isTTY) {
      // Non-TTY: single fetch and print
      const logs = await fetchLogs(
        tenant.ipAddress,
        config.vsock.agentPort,
        tenant.agentToken,
        opts.service,
      );
      if (logs) {
        process.stdout.write(`${logs}\n`);
      }
      return 0;
    }

    const { waitUntilExit } = render(
      <LogsApp
        tenant={tenant}
        agentPort={config.vsock.agentPort}
        service={opts.service}
      />,
    );

    await waitUntilExit();
    return 0;
  } catch (e) {
    console.error(
      `Failed to fetch logs: ${e instanceof Error ? e.message : e}`,
    );
    return 1;
  } finally {
    await release();
  }
}
