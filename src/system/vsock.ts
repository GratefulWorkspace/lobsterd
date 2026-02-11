import { Socket } from "node:net";
import { ResultAsync } from "neverthrow";
import type { GuestStats, LobsterError } from "../types/index.js";

function tcpSend(
  host: string,
  port: number,
  payload: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `TCP connection to ${host}:${port} timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    socket.connect(port, host, () => {
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.on("end", () => {
      clearTimeout(timer);
      socket.end();
      resolve(response);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function tcpConnect(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, timeoutMs);

    socket.connect(port, host, () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export function waitForAgent(
  guestIp: string,
  port: number,
  timeoutMs: number,
): ResultAsync<void, LobsterError> {
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
      throw new Error(
        `Agent on ${guestIp}:${port} did not respond within ${timeoutMs}ms`,
      );
    })(),
    (e) => ({
      code: "VSOCK_CONNECT_FAILED" as const,
      message: `Failed to connect to guest agent: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function injectSecrets(
  guestIp: string,
  port: number,
  secrets: Record<string, string>,
  agentToken: string,
): ResultAsync<void, LobsterError> {
  const payload = JSON.stringify({
    type: "inject-secrets",
    token: agentToken,
    secrets,
  });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, `${payload}\n`, 5000);
      if (!response.includes("ACK")) {
        throw new Error(`Secret injection failed: ${response}`);
      }
    })(),
    (e) => ({
      code: "VSOCK_CONNECT_FAILED" as const,
      message: `Failed to inject secrets: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function healthPing(
  guestIp: string,
  port: number,
  agentToken: string,
): ResultAsync<boolean, LobsterError> {
  const payload = JSON.stringify({ type: "health-ping", token: agentToken });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, `${payload}\n`, 5000);
      return response.includes("PONG");
    })(),
    () => ({
      code: "VSOCK_CONNECT_FAILED" as const,
      message: `Health ping failed for ${guestIp}`,
    }),
  );
}

export function getStats(
  guestIp: string,
  port: number,
  agentToken: string,
): ResultAsync<GuestStats, LobsterError> {
  const payload = JSON.stringify({ type: "get-stats", token: agentToken });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, `${payload}\n`, 3000);
      return JSON.parse(response.trim()) as GuestStats;
    })(),
    () => ({
      code: "VSOCK_CONNECT_FAILED" as const,
      message: `Stats request failed for ${guestIp}`,
    }),
  );
}

export function getLogs(
  guestIp: string,
  port: number,
  agentToken: string,
): ResultAsync<string, LobsterError> {
  const payload = JSON.stringify({ type: "get-logs", token: agentToken });
  return ResultAsync.fromPromise(
    (async () => {
      const response = await tcpSend(guestIp, port, `${payload}\n`, 5000);
      return response;
    })(),
    () => ({
      code: "VSOCK_CONNECT_FAILED" as const,
      message: `Log request failed for ${guestIp}`,
    }),
  );
}
