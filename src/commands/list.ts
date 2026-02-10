import { ResultAsync, ok, okAsync } from 'neverthrow';
import type { LobsterError, Tenant } from '../types/index.js';
import { loadRegistry } from '../config/loader.js';
import * as systemd from '../system/systemd.js';
import * as docker from '../system/docker.js';

export interface TenantListEntry {
  name: string;
  uid: number;
  port: number;
  status: string;
  docker: string;
  gateway: string;
}

function quickCheck(tenant: Tenant): ResultAsync<TenantListEntry, LobsterError> {
  const entry: TenantListEntry = {
    name: tenant.name,
    uid: tenant.uid,
    port: tenant.gatewayPort,
    status: tenant.status,
    docker: '?',
    gateway: '?',
  };

  return docker.isResponsive(tenant.name, tenant.uid)
    .map((isUp) => { entry.docker = isUp ? 'up' : 'down'; })
    .orElse(() => { entry.docker = 'err'; return okAsync(undefined); })
    .andThen(() => systemd.isActive('openclaw-gateway', tenant.name, tenant.uid))
    .map((active) => { entry.gateway = active ? 'up' : 'down'; })
    .orElse(() => { entry.gateway = 'err'; return okAsync(undefined); })
    .map(() => entry);
}

export function runList(
  opts: { json?: boolean } = {},
): ResultAsync<TenantListEntry[], LobsterError> {
  return loadRegistry().andThen((registry): ResultAsync<TenantListEntry[], LobsterError> => {
    if (registry.tenants.length === 0) {
      return okAsync([]);
    }
    return ResultAsync.combine(
      registry.tenants.map((t) => quickCheck(t)),
    );
  });
}

export function formatTable(entries: TenantListEntry[]): string {
  if (entries.length === 0) return 'No tenants registered.';

  const header = ['NAME', 'UID', 'PORT', 'STATUS', 'DOCKER', 'GATEWAY'];
  const rows = entries.map((e) => [e.name, String(e.uid), String(e.port), e.status, e.docker, e.gateway]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (row: string[]) => row.map((s, i) => pad(s, widths[i])).join('  ');

  return [line(header), '-'.repeat(widths.reduce((a, b) => a + b + 2, -2)), ...rows.map(line)].join('\n');
}
