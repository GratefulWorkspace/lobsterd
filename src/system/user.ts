import { ResultAsync, ok, err } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

export function checkUserExists(name: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['id', '-u', name]).map((r) => r.exitCode === 0);
}

export function createUser(
  name: string,
  uid: number,
  homePath: string,
): ResultAsync<void, LobsterError> {
  return exec([
    'useradd',
    '--uid', String(uid),
    '--home-dir', homePath,
    '--no-create-home', // ZFS mountpoint is the home dir
    '--shell', '/usr/sbin/nologin',
    name,
  ]).map(() => undefined);
}

export function deleteUser(name: string): ResultAsync<void, LobsterError> {
  return exec(['userdel', '--force', name]).map(() => undefined);
}

export function ensureSubuidRange(
  name: string,
  start: number,
  count: number = 65536,
): ResultAsync<void, LobsterError> {
  const entry = `${name}:${start}:${count}`;
  return ResultAsync.fromPromise(
    (async () => {
      for (const file of ['/etc/subuid', '/etc/subgid']) {
        const content = await Bun.file(file).text().catch(() => '');
        if (!content.includes(`${name}:`)) {
          await Bun.write(file, content.trimEnd() + '\n' + entry + '\n');
        }
      }
    })(),
    (e) => ({ code: 'EXEC_FAILED' as const, message: `Failed to configure subuid/subgid for ${name}`, cause: e }),
  );
}

export function enableLinger(name: string): ResultAsync<void, LobsterError> {
  return exec(['loginctl', 'enable-linger', name]).map(() => undefined);
}

export function waitForUserSession(uid: number, timeoutMs: number = 10_000): ResultAsync<void, LobsterError> {
  const runtimeDir = `/run/user/${uid}`;
  return ResultAsync.fromPromise(
    (async () => {
      const { existsSync } = await import('node:fs');
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (existsSync(`${runtimeDir}/systemd`)) return;
        await Bun.sleep(200);
      }
      throw new Error(`User session for uid ${uid} did not appear within ${timeoutMs}ms`);
    })(),
    (e) => ({ code: 'SESSION_TIMEOUT' as const, message: String(e instanceof Error ? e.message : e) }),
  );
}

export function disableLinger(name: string): ResultAsync<void, LobsterError> {
  return exec(['loginctl', 'disable-linger', name]).map(() => undefined);
}

export function isLingerEnabled(name: string): ResultAsync<boolean, LobsterError> {
  return execUnchecked(['loginctl', 'show-user', name, '--property=Linger']).map(
    (r) => r.exitCode === 0 && r.stdout.trim() === 'Linger=yes',
  );
}
