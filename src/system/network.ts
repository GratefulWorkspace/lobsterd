import { ResultAsync, okAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec } from './exec.js';

export function createTap(name: string, hostIp: string, guestIp: string): ResultAsync<void, LobsterError> {
  const cidr = `${hostIp}/30`;
  return exec(['ip', 'tuntap', 'add', 'dev', name, 'mode', 'tap'])
    .andThen(() => exec(['ip', 'addr', 'add', cidr, 'dev', name]))
    .andThen(() => exec(['ip', 'link', 'set', name, 'up']))
    .map(() => undefined)
    .mapErr((e) => ({
      ...e,
      code: 'TAP_CREATE_FAILED' as const,
      message: `Failed to create TAP ${name}: ${e.message}`,
    }));
}

export function deleteTap(name: string): ResultAsync<void, LobsterError> {
  return exec(['ip', 'link', 'delete', name])
    .map(() => undefined)
    .orElse(() => okAsync(undefined));
}

export function addNat(tapName: string, guestIp: string, gatewayPort: number): ResultAsync<void, LobsterError> {
  return exec([
    'iptables', '-t', 'nat', '-A', 'PREROUTING',
    '-p', 'tcp', '--dport', String(gatewayPort),
    '-j', 'DNAT', '--to-destination', `${guestIp}:${gatewayPort}`,
    '-m', 'comment', '--comment', `lobster:${tapName}`,
  ]).andThen(() =>
    exec([
      'iptables', '-t', 'nat', '-A', 'POSTROUTING',
      '-o', tapName,
      '-j', 'MASQUERADE',
      '-m', 'comment', '--comment', `lobster:${tapName}`,
    ]),
  ).map(() => undefined);
}

export function removeNat(tapName: string, guestIp: string, gatewayPort: number): ResultAsync<void, LobsterError> {
  return exec([
    'iptables', '-t', 'nat', '-D', 'PREROUTING',
    '-p', 'tcp', '--dport', String(gatewayPort),
    '-j', 'DNAT', '--to-destination', `${guestIp}:${gatewayPort}`,
    '-m', 'comment', '--comment', `lobster:${tapName}`,
  ]).orElse(() => okAsync({ exitCode: 0, stdout: '', stderr: '' }))
    .andThen(() =>
      exec([
        'iptables', '-t', 'nat', '-D', 'POSTROUTING',
        '-o', tapName,
        '-j', 'MASQUERADE',
        '-m', 'comment', '--comment', `lobster:${tapName}`,
      ]).orElse(() => okAsync({ exitCode: 0, stdout: '', stderr: '' })),
    )
    .map(() => undefined);
}

export function enableIpForwarding(): ResultAsync<void, LobsterError> {
  return exec(['sysctl', '-w', 'net.ipv4.ip_forward=1']).map(() => undefined);
}
