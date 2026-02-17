import { ResultAsync } from "neverthrow";
import * as ssh from "../system/ssh.js";
import type { LobsterError } from "../types/index.js";
import { withHold } from "./hold.js";

export function runExec(
  name: string,
  command?: string[],
): ResultAsync<number, LobsterError> {
  return withHold(name).andThen(({ tenant, release }) => {
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

    sshArgs.push(`root@${tenant.ipAddress}`);

    if (command && command.length > 0) {
      sshArgs.push(...command);
    }

    return ResultAsync.fromPromise(
      (async () => {
        try {
          const proc = Bun.spawn(sshArgs, {
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
          });
          return await proc.exited;
        } finally {
          await release();
        }
      })(),
      (e): LobsterError => ({
        code: "EXEC_FAILED",
        message: `Failed to exec into tenant "${name}": ${e instanceof Error ? e.message : String(e)}`,
        cause: e,
      }),
    );
  });
}
