import { ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant } from '../types/index.js';
import { loadConfig, loadRegistry } from '../config/loader.js';
import * as vsock from '../system/vsock.js';

export interface TenantListEntry {
  name: string;
  cid: number;
  ip: string;
  port: number;
  vmPid: string;
  status: string;
  memoryMb?: number;
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
  return loadConfig().andThen((config) =>
    loadRegistry().andThen((registry) => {
      const entries = registry.tenants.map((t) => quickCheck(t));

      const statsPromises = entries.map((entry, i) => {
        if (entry.vmPid === 'dead') return Promise.resolve();
        const tenant = registry.tenants[i];
        return vsock
          .getStats(tenant.ipAddress, config.vsock.agentPort, tenant.agentToken)
          .map((stats) => {
            entry.memoryMb = stats.memoryKb > 0 ? Math.round(stats.memoryKb / 1024) : undefined;
          })
          .unwrapOr(undefined);
      });

      return ResultAsync.fromPromise(
        Promise.all(statsPromises).then(() => entries),
        () => ({
          code: 'VSOCK_CONNECT_FAILED' as const,
          message: 'Failed to collect stats',
        }),
      );
    }),
  );
}

export function formatTable(entries: TenantListEntry[]): string {
  if (entries.length === 0) return 'No tenants registered.';

  const header = ['NAME', 'CID', 'IP', 'PORT', 'PID', 'STATUS', 'MEM'];
  const rows = entries.map((e) => [
    e.name,
    String(e.cid),
    e.ip,
    String(e.port),
    e.vmPid,
    e.status,
    e.memoryMb != null ? `${e.memoryMb}M` : '--',
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (s: string, w: number) => s.padEnd(w);
  const line = (row: string[]) => row.map((s, i) => pad(s, widths[i])).join('  ');

  return [line(header), '-'.repeat(widths.reduce((a, b) => a + b + 2, -2)), ...rows.map(line)].join('\n');
}
