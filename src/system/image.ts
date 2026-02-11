import type { ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";
import { exec } from "./exec.js";

export function createOverlay(
  path: string,
  sizeMb: number,
): ResultAsync<void, LobsterError> {
  return exec(["truncate", "-s", `${sizeMb}M`, path])
    .andThen(() => exec(["mkfs.ext4", "-F", "-q", path]))
    .map(() => undefined)
    .mapErr((e) => ({
      ...e,
      code: "OVERLAY_CREATE_FAILED" as const,
      message: `Failed to create overlay at ${path}: ${e.message}`,
    }));
}

export function deleteOverlay(path: string): ResultAsync<void, LobsterError> {
  return exec(["rm", "-f", path]).map(() => undefined);
}

export function resizeOverlay(
  path: string,
  newSizeMb: number,
): ResultAsync<void, LobsterError> {
  return exec(["truncate", "-s", `${newSizeMb}M`, path])
    .andThen(() =>
      exec(["e2fsck", "-f", "-y", path]).orElse(() => exec(["true"])),
    )
    .andThen(() => exec(["resize2fs", path]))
    .map(() => undefined);
}
