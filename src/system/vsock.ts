import { ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { execUnchecked } from './exec.js';

export function waitForAgent(cid: number, port: number, timeoutMs: number): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const start = Date.now();
      const pollMs = 500;
      while (Date.now() - start < timeoutMs) {
        const result = await execUnchecked([
          'socat', '-T1', '-',
          `VSOCK-CONNECT:${cid}:${port}`,
        ], { timeout: 3000 });
        if (result.isOk() && result.value.exitCode === 0) {
          return;
        }
        await Bun.sleep(pollMs);
      }
      throw new Error(`Agent on CID ${cid}:${port} did not respond within ${timeoutMs}ms`);
    })(),
    (e) => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Failed to connect to guest agent: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function injectSecrets(
  cid: number,
  port: number,
  secrets: Record<string, string>,
): ResultAsync<void, LobsterError> {
  const payload = JSON.stringify({ type: 'inject-secrets', secrets });
  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn(['socat', '-T5', '-', `VSOCK-CONNECT:${cid}:${port}`], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(payload + '\n');
      proc.stdin.end();
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      if (exitCode !== 0 || !stdout.includes('ACK')) {
        throw new Error(`Secret injection failed (exit ${exitCode}): ${stdout}`);
      }
    })(),
    (e) => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Failed to inject secrets: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function healthPing(cid: number, port: number): ResultAsync<boolean, LobsterError> {
  const payload = JSON.stringify({ type: 'health-ping' });
  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn(['socat', '-T3', '-', `VSOCK-CONNECT:${cid}:${port}`], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(payload + '\n');
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill(), 5000);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      const stdout = await new Response(proc.stdout).text();
      return exitCode === 0 && stdout.includes('PONG');
    })(),
    () => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Health ping failed for CID ${cid}`,
    }),
  );
}
