import { chmodSync, closeSync, openSync, unlinkSync } from "node:fs";
import { err, ok, ResultAsync } from "neverthrow";
import type {
  LobsterdConfig,
  LobsterError,
  TenantRegistry,
} from "../types/index.js";
import {
  CONFIG_PATH,
  DEFAULT_CONFIG,
  EMPTY_REGISTRY,
  REGISTRY_PATH,
} from "./defaults.js";
import { lobsterdConfigSchema, tenantRegistrySchema } from "./schema.js";

// ── Lockfile helpers ────────────────────────────────────────────────────────

const REGISTRY_LOCK = "/etc/lobsterd/registry.lock";
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_POLL_MS = 100;

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      const fd = openSync(lockPath, "wx");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return;
    } catch (e: unknown) {
      if (
        e instanceof Error &&
        "code" in e &&
        (e as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        // Stale lock detection: read PID and check if alive
        try {
          const content = await Bun.file(lockPath).text();
          const pid = parseInt(content.trim(), 10);
          if (!Number.isNaN(pid) && !isPidAlive(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          // Lock file disappeared or unreadable — retry
        }
        await Bun.sleep(LOCK_POLL_MS);
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `Timed out acquiring lock ${lockPath} after ${LOCK_TIMEOUT_MS}ms`,
  );
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already removed
  }
}

// ── JSON I/O ────────────────────────────────────────────────────────────────

function readJsonFile<T>(path: string): ResultAsync<T | null, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return null;
      }
      return (await file.json()) as T;
    })(),
    (e) => ({
      code: "CONFIG_NOT_FOUND" as const,
      message: `Failed to read ${path}`,
      cause: e,
    }),
  );
}

function writeJsonFileAtomic(
  path: string,
  data: unknown,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const tmpPath = `${path}.tmp.${process.pid}`;
      await Bun.write(tmpPath, `${JSON.stringify(data, null, 2)}\n`);
      chmodSync(tmpPath, 0o600);
      const proc = Bun.spawn(["mv", tmpPath, path]);
      await proc.exited;
      if (proc.exitCode !== 0) {
        throw new Error(`mv failed with exit code ${proc.exitCode}`);
      }
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: `Failed to write ${path}`,
      cause: e,
    }),
  );
}

// ── Config ──────────────────────────────────────────────────────────────────

export function loadConfig(): ResultAsync<LobsterdConfig, LobsterError> {
  return readJsonFile<LobsterdConfig>(CONFIG_PATH).andThen((data) => {
    if (data === null) {
      return ok(DEFAULT_CONFIG);
    }
    const parsed = lobsterdConfigSchema.safeParse(data);
    if (!parsed.success) {
      return err({
        code: "CONFIG_INVALID" as const,
        message: `Invalid config: ${parsed.error.message}`,
      });
    }
    return ok(parsed.data as LobsterdConfig);
  });
}

export function saveConfig(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return writeJsonFileAtomic(CONFIG_PATH, config);
}

// ── Registry ────────────────────────────────────────────────────────────────

export function loadRegistry(): ResultAsync<TenantRegistry, LobsterError> {
  return readJsonFile<TenantRegistry>(REGISTRY_PATH).andThen((data) => {
    if (data === null) {
      return ok(EMPTY_REGISTRY);
    }
    const parsed = tenantRegistrySchema.safeParse(data);
    if (!parsed.success) {
      return err({
        code: "CONFIG_INVALID" as const,
        message: `Invalid registry: ${parsed.error.message}`,
      });
    }
    return ok(parsed.data as TenantRegistry);
  });
}

export function saveRegistry(
  registry: TenantRegistry,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      await acquireLock(REGISTRY_LOCK);
      try {
        const tmpPath = `${REGISTRY_PATH}.tmp.${process.pid}`;
        await Bun.write(tmpPath, `${JSON.stringify(registry, null, 2)}\n`);
        chmodSync(tmpPath, 0o600);
        const proc = Bun.spawn(["mv", tmpPath, REGISTRY_PATH]);
        await proc.exited;
        if (proc.exitCode !== 0) {
          throw new Error(`mv failed with exit code ${proc.exitCode}`);
        }
      } finally {
        releaseLock(REGISTRY_LOCK);
      }
    })(),
    (e) => ({
      code: "LOCK_FAILED" as const,
      message: `Failed to save registry: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}
