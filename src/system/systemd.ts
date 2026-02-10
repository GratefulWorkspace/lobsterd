import { ResultAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

function userEnv(uid: number): Record<string, string> {
  return { XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

function systemctlUser(
  action: string,
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return exec(
    ['systemctl', '--user', action, unit],
    { asUser: username, env: userEnv(uid) },
  ).map(() => undefined);
}

export function enableService(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return systemctlUser('enable', unit, username, uid);
}

export function startService(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return systemctlUser('start', unit, username, uid);
}

export function stopService(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return systemctlUser('stop', unit, username, uid);
}

export function restartService(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return systemctlUser('restart', unit, username, uid);
}

export function isActive(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<boolean, LobsterError> {
  return execUnchecked(
    ['systemctl', '--user', 'is-active', unit],
    { asUser: username, env: userEnv(uid) },
  ).map((r) => r.stdout.trim() === 'active');
}

export function isFailed(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<boolean, LobsterError> {
  return execUnchecked(
    ['systemctl', '--user', 'is-failed', unit],
    { asUser: username, env: userEnv(uid) },
  ).map((r) => r.stdout.trim() === 'failed');
}

export function daemonReload(
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return exec(
    ['systemctl', '--user', 'daemon-reload'],
    { asUser: username, env: userEnv(uid) },
  ).map(() => undefined);
}

export function resetFailed(
  unit: string,
  username: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  return execUnchecked(
    ['systemctl', '--user', 'reset-failed', unit],
    { asUser: username, env: userEnv(uid) },
  ).map(() => undefined);
}

export function streamLogs(
  unit: string,
  username: string,
  uid: number,
): Bun.Subprocess {
  return Bun.spawn(
    ['sudo', '-u', username, '--', 'journalctl', '--user-unit', unit, '-f', '--no-pager', '-o', 'short'],
    {
      env: { ...process.env, ...userEnv(uid) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}
