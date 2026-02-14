import { okAsync, type ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";
import { exec } from "./exec.js";

const SSH_BASE_DIR = "/var/lib/lobsterd/ssh";

export function getPrivateKeyPath(tenantName: string): string {
  return `${SSH_BASE_DIR}/${tenantName}/id_ed25519`;
}

export function generateKeypair(
  tenantName: string,
): ResultAsync<string, LobsterError> {
  const keyDir = `${SSH_BASE_DIR}/${tenantName}`;
  const keyPath = `${keyDir}/id_ed25519`;

  return exec(["mkdir", "-p", keyDir])
    .andThen(() =>
      exec([
        "ssh-keygen",
        "-t",
        "ed25519",
        "-f",
        keyPath,
        "-N",
        "",
        "-C",
        `lobsterd-${tenantName}`,
      ]),
    )
    .andThen(() => exec(["chmod", "600", keyPath]))
    .andThen(() => exec(["cat", `${keyPath}.pub`]))
    .map((r) => r.stdout.trim())
    .mapErr((e) => ({
      ...e,
      code: "EXEC_FAILED" as const,
      message: `Failed to generate SSH keypair for ${tenantName}: ${e.message}`,
    }));
}

export function removeKeypair(
  tenantName: string,
): ResultAsync<void, LobsterError> {
  const keyDir = `${SSH_BASE_DIR}/${tenantName}`;
  return exec(["rm", "-rf", keyDir])
    .map(() => undefined)
    .orElse(() => okAsync(undefined));
}
