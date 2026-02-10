import { ResultAsync, okAsync } from 'neverthrow';
import type { LobsterError, Tenant } from '../types/index.js';
import { loadRegistry } from '../config/loader.js';

export interface TenantListEntry {
  name: string;
  cid: number;
  ip: string;
  port: number;
  vmPid: string;
  status: string;
}

function quickCheck(tenant: Tenant): TenantListEntry {
  let pidStatus = 'dead';
  if (tenant.vmPid) {
    try {
      process.kill(tenant.vmPid, 0);
      pidStatus = String(tenant.vmPid);
    } catch {
      pidStatus = 'dead';
    }
  }

  return {
    name: tenant.name,
    cid: tenant.cid,
    ip: tenant.ipAddress,
    port: tenant.gatewayPort,
    vmPid: pidStatus,
    status: tenant.status,
  };
}

export function runList(
  opts: { json?: boolean } = {},
): ResultAsync<TenantListEntry[], LobsterError> {
  return loadRegistry().map((registry) =>
    registry.tenants.map((t) => quickCheck(t)),
  );
}

export function formatTable(entries: TenantListEntry[]): string {
  if (entries.length === 0) return 'No tenants registered.';

  const header = ['NAME', 'CID', 'IP', 'PORT', 'PID', 'STATUS'];
  const rows = entries.map((e) => [e.name, String(e.cid), e.ip, String(e.port), e.vmPid, e.status]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (row: string[]) => row.map((s, i) => pad(s, widths[i])).join('  ');

  return [line(header), '-'.repeat(widths.reduce((a, b) => a + b + 2, -2)), ...rows.map(line)].join('\n');
}
