import crypto from "node:crypto";
import { render, useApp, useInput } from "ink";
import { okAsync } from "neverthrow";
import { useEffect, useState } from "react";
import { loadConfig, loadRegistry } from "../config/loader.js";
import { fetchLogs } from "../system/logs.js";
import * as vsock from "../system/vsock.js";
import type { Tenant } from "../types/index.js";
import { LogStream } from "../ui/LogStream.js";

const HOLD_TTL_MS = 5 * 60_000; // 5 minutes
const KEEPALIVE_MS = 2 * 60_000; // 2 minutes

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

  const tenant = registryResult.value.tenants.find((t) => t.name === name);
  if (!tenant) {
    console.error(`Tenant "${name}" not found`);
    return 1;
  }

  const holdId = crypto.randomUUID();
  const { ipAddress, agentToken } = tenant;
  const agentPort = config.vsock.agentPort;

  // Acquire hold (soft-fail)
  await vsock
    .acquireHold(ipAddress, agentPort, agentToken, holdId, HOLD_TTL_MS)
    .orElse(() => okAsync(undefined));

  if (!process.stdin.isTTY) {
    // Non-TTY: single fetch and print
    try {
      const logs = await fetchLogs(
        tenant.ipAddress,
        config.vsock.agentPort,
        tenant.agentToken,
        opts.service,
      );
      if (logs) {
        process.stdout.write(`${logs}\n`);
      }
    } catch (e) {
      console.error(
        `Failed to fetch logs: ${e instanceof Error ? e.message : e}`,
      );
      await vsock
        .releaseHold(ipAddress, agentPort, agentToken, holdId)
        .orElse(() => okAsync(undefined));
      return 1;
    }
    await vsock
      .releaseHold(ipAddress, agentPort, agentToken, holdId)
      .orElse(() => okAsync(undefined));
    return 0;
  }

  // TTY mode: start keepalive
  const keepalive = setInterval(() => {
    vsock
      .acquireHold(ipAddress, agentPort, agentToken, holdId, HOLD_TTL_MS)
      .orElse(() => okAsync(undefined));
  }, KEEPALIVE_MS);

  const { waitUntilExit } = render(
    <LogsApp
      tenant={tenant}
      agentPort={config.vsock.agentPort}
      service={opts.service}
    />,
  );

  await waitUntilExit();

  clearInterval(keepalive);
  await vsock
    .releaseHold(ipAddress, agentPort, agentToken, holdId)
    .orElse(() => okAsync(undefined));
  return 0;
}
