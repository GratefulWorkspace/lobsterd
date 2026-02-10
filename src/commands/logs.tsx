import React, { useState, useEffect } from 'react';
import { render, useApp, useInput } from 'ink';
import type { Tenant } from '../types/index.js';
import { loadRegistry } from '../config/loader.js';
import { LogStream } from '../ui/LogStream.js';

function LogsApp({ tenant }: { tenant: Tenant }) {
  const [lines, setLines] = useState<string[]>([]);
  const { exit } = useApp();

  useInput((input) => {
    if (input === 'q') exit();
  });

  useEffect(() => {
    let cancelled = false;

    async function pollLogs() {
      // Poll guest agent for logs via vsock
      while (!cancelled) {
        try {
          // For now, read from Caddy access log via host
          const proc = Bun.spawn(['tail', '-f', `/var/log/caddy/access-${tenant.name}.log`], {
            stdout: 'pipe',
            stderr: 'pipe',
          });

          const reader = (proc.stdout as ReadableStream).getReader();
          try {
            while (!cancelled) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = new TextDecoder().decode(value);
              const parts = text.split('\n').filter(Boolean);
              if (parts.length > 0) {
                setLines((prev) => [...prev, ...parts]);
              }
            }
          } catch {
            // Stream ended
          }
          proc.kill();
        } catch {
          // Retry after a delay
          await Bun.sleep(2000);
        }
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
    // Non-TTY: tail Caddy access log
    const logPath = `/var/log/caddy/access-${tenant.name}.log`;
    const proc = Bun.spawn(['tail', '-f', logPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
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
    <LogsApp tenant={tenant} />,
  );

  await waitUntilExit();
  return 0;
}
