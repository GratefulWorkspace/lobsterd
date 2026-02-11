import { errAsync, ResultAsync } from "neverthrow";
import { loadConfig, loadRegistry } from "../config/loader.js";
import { exec } from "../system/exec.js";
import type { LobsterError } from "../types/index.js";
import { tmpdir } from "os";
import { join } from "path";

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export interface SnapResult {
  path: string;
  tenant: string;
  timestamp: string;
}

export function runSnap(
  name: string,
  _opts: { json?: boolean } = {},
): ResultAsync<SnapResult, LobsterError> {
  const outDir = join(process.cwd(), "snaps");
  const timestamp = formatTimestamp();
  const tarName = `${timestamp}-${name}.tar.gz`;
  const tarPath = join(outDir, tarName);
  return loadConfig()
    .andThen(() => loadRegistry())
    .andThen((registry): ResultAsync<SnapResult, LobsterError> => {
      const tenant = registry.tenants.find((t) => t.name === name);
      if (!tenant) {
        return errAsync({
          code: "TENANT_NOT_FOUND",
          message: `Tenant "${name}" not found`,
        });
      }

      const overlayPath = tenant.overlayPath;
      const tmpDir = join(tmpdir(), `lobsterd-snap-${name}-${timestamp}`);

      return exec(["mkdir", "-p", outDir])
        .andThen(() => exec(["mkdir", "-p", tmpDir]))
        .andThen(() =>
          exec(["cp", "--sparse=always", overlayPath, join(tmpDir, "overlay.ext4")], {
            timeout: 120_000,
          }),
        )
        .andThen(() =>
          exec(
            ["tar", "--sparse", "-czf", tarPath, "-C", tmpDir, "overlay.ext4"],
            { timeout: 120_000 },
          ),
        )
        .andThen(() => exec(["rm", "-rf", tmpDir]))
        .map(() => ({ path: tarPath, tenant: name, timestamp }));
    });
}
