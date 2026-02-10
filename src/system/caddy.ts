import { ResultAsync, okAsync } from 'neverthrow';
import type { LobsterError } from '../types/index.js';
import { exec } from './exec.js';

function caddyApi(
  adminApi: string,
  method: string,
  path: string,
  body?: unknown,
): ResultAsync<unknown, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const res = await fetch(`${adminApi}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Caddy API ${method} ${path} failed (${res.status}): ${text}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    })(),
    (e) => ({
      code: 'CADDY_API_ERROR' as const,
      message: `Caddy API error: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function addRoute(
  adminApi: string,
  tenantName: string,
  domain: string,
  upstreamPort: number,
): ResultAsync<void, LobsterError> {
  const route = {
    '@id': `lobster-${tenantName}`,
    match: [{ host: [`${tenantName}.${domain}`] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: `localhost:${upstreamPort}` }],
      },
    ],
  };
  return caddyApi(
    adminApi,
    'POST',
    '/config/apps/http/servers/lobster/routes',
    route,
  ).map(() => undefined);
}

export function removeRoute(
  adminApi: string,
  tenantName: string,
): ResultAsync<void, LobsterError> {
  return caddyApi(
    adminApi,
    'DELETE',
    `/id/lobster-${tenantName}`,
  ).map(() => undefined)
    .orElse(() => okAsync(undefined));
}

export function listRoutes(adminApi: string): ResultAsync<unknown[], LobsterError> {
  return caddyApi(
    adminApi,
    'GET',
    '/config/apps/http/servers/lobster/routes',
  ).map((data) => (Array.isArray(data) ? data : []));
}

export function ensureCaddyRunning(): ResultAsync<void, LobsterError> {
  return exec(['systemctl', 'enable', '--now', 'caddy']).map(() => undefined);
}

export function writeCaddyBaseConfig(adminApi: string, domain: string): ResultAsync<void, LobsterError> {
  const config = {
    apps: {
      http: {
        servers: {
          lobster: {
            listen: [':443', ':80'],
            routes: [],
            automatic_https: {
              disable_redirects: false,
            },
          },
        },
      },
    },
  };
  return caddyApi(adminApi, 'POST', '/load', config).map(() => undefined);
}
