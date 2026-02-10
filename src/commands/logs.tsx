import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import type { Tenant } from '../types/index.js';
import { loadRegistry } from '../config/loader.js';
import * as systemd from '../system/systemd.js';
import { LogStream } from '../ui/LogStream.js';

function LogsApp({ tenant, service }: { tenant: Tenant; service: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') exit();
  });

  useEffect(() => {
    const proc = systemd.streamLogs(service, tenant.name, tenant.uid);
    let buffer = '';

    async function readStream() {
      const reader = (proc.stdout as ReadableStream).getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += new TextDecoder().decode(value);
          const parts = buffer.split('\n');
          buffer = parts.pop() ?? '';
          if (parts.length > 0) {
            setLines((prev) => [...prev, ...parts]);
          }
        }
      } catch {
        // Stream ended
      }
    }

    readStream();
    return () => { proc.kill(); };
  }, []);

  return (
    <LogStream
      title={`${tenant.name} — ${service}`}
      lines={lines}
    />
  );
}

export async function runLogs(
  name: string,
  opts: { service?: string } = {},
): Promise<number> {
  const service = opts.service ?? 'openclaw-gateway';

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
    const proc = systemd.streamLogs(service, tenant.name, tenant.uid);
    const reader = (proc.stdout as ReadableStream).getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        process.stdout.write(decoder.decode(value));
      }
    } catch {
      // Stream ended
    }
    proc.kill();
    return 0;
  }

  const { waitUntilExit } = render(
    <LogsApp tenant={tenant} service={service} />,
  );

  await waitUntilExit();
  return 0;
}
