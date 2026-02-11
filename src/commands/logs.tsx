import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import type { Tenant } from '../types/index.js';
import { loadRegistry, loadConfig } from '../config/loader.js';
import { LogStream } from '../ui/LogStream.js';
import * as vsock from '../system/vsock.js';

function fetchLogs(guestIp: string, port: number, agentToken: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { Socket } = require('net');
    const socket = new Socket();
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, 5000);

    socket.connect(port, guestIp, () => {
      socket.write(JSON.stringify({ type: 'get-logs', token: agentToken }) + '\n');
    });
    socket.on('data', (chunk: Buffer) => { response += chunk.toString(); });
    socket.on('end', () => {
      clearTimeout(timer);
      socket.end();
      resolve(response.trim());
    });
    socket.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function LogsApp({ tenant, agentPort }: { tenant: Tenant; agentPort: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') exit();
  });

  useEffect(() => {
    let cancelled = false;

    async function pollLogs() {
      while (!cancelled) {
        try {
          const logs = await fetchLogs(tenant.ipAddress, agentPort, tenant.agentToken);
          if (logs) {
            const parts = logs.split('\n').filter(Boolean);
            setLines(parts);
          }
        } catch {
          // Agent not reachable, retry
        }
        await Bun.sleep(3000);
      }
    }

    pollLogs();
    return () => { cancelled = true; };
  }, []);

  return (
    <LogStream
      title={`${tenant.name} — logs`}
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

  if (!process.stdin.isTTY) {
    // Non-TTY: single fetch and print
    try {
      const logs = await fetchLogs(tenant.ipAddress, config.vsock.agentPort, tenant.agentToken);
      if (logs) process.stdout.write(logs + '\n');
    } catch (e) {
      console.error(`Failed to fetch logs: ${e instanceof Error ? e.message : e}`);
      return 1;
    }
    return 0;
  }

  const { waitUntilExit } = render(
    <LogsApp tenant={tenant} agentPort={config.vsock.agentPort} />,
  );

  await waitUntilExit();
  return 0;
}
