import { errAsync, ResultAsync } from "neverthrow";
import { loadRegistry } from "../config/loader.js";
import * as ssh from "../system/ssh.js";
import type { LobsterError } from "../types/index.js";

export function runExec(
  name: string,
  command?: string[],
): ResultAsync<number, LobsterError> {
  return loadRegistry().andThen((registry) => {
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

    if (!command || command.length === 0) {
      sshArgs.push("-t");
    }

    sshArgs.push(`root@${tenant.ipAddress}`);

    if (command && command.length > 0) {
      sshArgs.push("--", ...command);
    }

    return ResultAsync.fromPromise(
      (async () => {
        const proc = Bun.spawn(sshArgs, {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        return await proc.exited;
      })(),
      (e): LobsterError => ({
        code: "EXEC_FAILED",
        message: `Failed to exec into tenant "${name}": ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
    );
  });
}
