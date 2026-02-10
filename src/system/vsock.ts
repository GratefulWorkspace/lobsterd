import { ResultAsync } from 'neverthrow';
import { Socket } from 'net';
import type { LobsterError } from '../types/index.js';

function tcpSend(host: string, port: number, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.connect(port, host, () => {
      socket.write(payload);
      socket.end();
    });
    socket.on('data', (chunk) => { response += chunk.toString(); });
    socket.on('end', () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timeout'));
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForAgent(guestIp: string, port: number, timeoutMs: number): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const start = Date.now();
      const pollMs = 500;
      while (Date.now() - start < timeoutMs) {
        try {
          await tcpConnect(guestIp, port, 3000);
          return;
        } catch {
          // Agent not ready yet
        }
        await Bun.sleep(pollMs);
      }
      throw new Error(`Agent on ${guestIp}:${port} did not respond within ${timeoutMs}ms`);
    })(),
    (e) => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Failed to connect to guest agent: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function injectSecrets(
  guestIp: string,
  port: number,
  secrets: Record<string, string>,
): ResultAsync<void, LobsterError> {
  const payload = JSON.stringify({ type: 'inject-secrets', secrets });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, payload + '\n', 5000);
      if (!response.includes('ACK')) {
        throw new Error(`Secret injection failed: ${response}`);
      }
    })(),
    (e) => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Failed to inject secrets: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function healthPing(guestIp: string, port: number): ResultAsync<boolean, LobsterError> {
  const payload = JSON.stringify({ type: 'health-ping' });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, payload + '\n', 5000);
      return response.includes('PONG');
    })(),
    () => ({
      code: 'VSOCK_CONNECT_FAILED' as const,
      message: `Health ping failed for ${guestIp}`,
    }),
  );
}
