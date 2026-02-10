import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { loadConfig, loadRegistry } from '../config/loader.js';
import { exec } from '../system/exec.js';

function formatSnapName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

export function runSnap(
  name: string,
  opts: { prune?: boolean } = {},
): ResultAsync<string, LobsterError> {
  let overlayPath: string;
  let snapshotDir: string;
  let retention: number;

  return loadConfig()
    .andThen((config) => {
      retention = config.overlay.snapshotRetention;
      return loadRegistry();
    })
    .andThen((registry): ResultAsync<string, LobsterError> => {
      const tenant = registry.tenants.find((t) => t.name === name);
      if (!tenant) {
        return errAsync({ code: 'TENANT_NOT_FOUND', message: `Tenant "${name}" not found` });
      }
      overlayPath = tenant.overlayPath;
      snapshotDir = `${overlayPath}.snapshots`;
      const snapName = formatSnapName();
      const snapPath = `${snapshotDir}/${snapName}.ext4`;

      return exec(['mkdir', '-p', snapshotDir])
        .andThen(() => exec(['cp', '--sparse=always', overlayPath, snapPath]))
        .map(() => snapName);
    })
    .andThen((snapName): ResultAsync<string, LobsterError> => {
      if (!opts.prune) return okAsync(snapName);

      return ResultAsync.fromPromise(
        (async () => {
          const proc = Bun.spawn(['ls', '-1', snapshotDir], { stdout: 'pipe', stderr: 'pipe' });
          const stdout = await new Response(proc.stdout).text();
          await proc.exited;
          const snaps = stdout.trim().split('\n').filter(Boolean).sort();
          if (snaps.length <= retention) return snapName;

          const toRemove = snaps.slice(0, snaps.length - retention);
          for (const s of toRemove) {
            await exec(['rm', '-f', `${snapshotDir}/${s}`]);
          }
          return snapName;
        })(),
        (e): LobsterError => ({ code: 'EXEC_FAILED', message: `Failed to prune snapshots: ${e}` }),
      );
    });
}
