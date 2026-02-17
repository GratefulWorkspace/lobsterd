import crypto from "node:crypto";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import { loadConfig, loadRegistry } from "../config/loader.js";
import * as ssh from "../system/ssh.js";
import * as vsock from "../system/vsock.js";
import type { LobsterError } from "../types/index.js";

const HOLD_TTL_MS = 5 * 60_000; // 5 minutes
const KEEPALIVE_MS = 2 * 60_000; // 2 minutes

export function runExec(
  name: string,
  command?: string[],
): ResultAsync<number, LobsterError> {
  return loadConfig().andThen((config) =>
    loadRegistry().andThen((registry) => {
      const tenant = registry.tenants.find((t) => t.name === name);
      if (!tenant) {
        return errAsync({
          code: "TENANT_NOT_FOUND" as const,
          message: `Tenant "${name}" not found`,
        });
      }

      if (tenant.status !== "active") {
        return errAsync({
          code: "VALIDATION_FAILED" as const,
          message: `Tenant "${name}" is not active (status: ${tenant.status})`,
        });
      }

      const holdId = crypto.randomUUID();
      const { ipAddress, agentToken } = tenant;
      const agentPort = config.vsock.agentPort;

      const keyPath = ssh.getPrivateKeyPath(name);
      const sshArgs = [
        "ssh",
        "-i",
        keyPath,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ConnectTimeout=10",
      ];

      if (process.stdin.isTTY) {
        sshArgs.push("-t");
      }

      sshArgs.push(`root@${ipAddress}`);

      if (command && command.length > 0) {
        sshArgs.push(...command);
      }

      return ResultAsync.fromPromise(
        (async () => {
          // Acquire hold (soft-fail — don't crash if agent is slow)
          await vsock
            .acquireHold(ipAddress, agentPort, agentToken, holdId, HOLD_TTL_MS)
            .orElse(() => okAsync(undefined));

          const keepalive = setInterval(() => {
            vsock
              .acquireHold(
                ipAddress,
                agentPort,
                agentToken,
                holdId,
                HOLD_TTL_MS,
              )
              .orElse(() => okAsync(undefined));
          }, KEEPALIVE_MS);

          try {
            const proc = Bun.spawn(sshArgs, {
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            });
            return await proc.exited;
          } finally {
            clearInterval(keepalive);
            await vsock
              .releaseHold(ipAddress, agentPort, agentToken, holdId)
              .orElse(() => okAsync(undefined));
          }
        })(),
        (e): LobsterError => ({
          code: "EXEC_FAILED",
          message: `Failed to exec into tenant "${name}": ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      );
    }),
  );
}
