import { ResultAsync, okAsync } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import { execUnchecked } from '../system/exec.js';
import * as caddy from '../system/caddy.js';

export function checkTapDevice(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return execUnchecked(['ip', 'link', 'show', tenant.tapDev])
    .map((r): HealthCheckResult =>
      r.exitCode === 0
        ? { check: 'net.tap', status: 'ok', message: `TAP device ${tenant.tapDev} exists` }
        : { check: 'net.tap', status: 'failed', message: `TAP device ${tenant.tapDev} not found` },
    )
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: 'net.tap',
        status: 'failed',
        message: `Failed to check TAP device ${tenant.tapDev}`,
      }),
    );
}

export function checkGatewayPort(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return ResultAsync.fromSafePromise(
    (async (): Promise<HealthCheckResult> => {
      try {
        const socket = await Bun.connect({
          hostname: 'localhost',
          port: tenant.gatewayPort,
          socket: {
            data() {},
            open(socket) { socket.end(); },
            error() {},
          },
        });
        return { check: 'net.gateway', status: 'ok', message: `Port ${tenant.gatewayPort} is reachable` };
      } catch {
        return { check: 'net.gateway', status: 'failed', message: `Port ${tenant.gatewayPort} is not reachable` };
      }
    })(),
  );
}

export function checkCaddyRoute(tenant: Tenant, adminApi: string): ResultAsync<HealthCheckResult, LobsterError> {
  return caddy.listRoutes(adminApi)
    .map((routes): HealthCheckResult => {
      const found = routes.some((r: any) => r?.['@id'] === `lobster-${tenant.name}`);
      return found
        ? { check: 'net.caddy-route', status: 'ok', message: `Caddy route lobster-${tenant.name} exists` }
        : { check: 'net.caddy-route', status: 'failed', message: `Caddy route lobster-${tenant.name} not found` };
    })
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: 'net.caddy-route',
        status: 'failed',
        message: 'Failed to query Caddy routes',
      }),
    );
}

export function runNetworkChecks(tenant: Tenant, adminApi: string): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkTapDevice(tenant),
    checkGatewayPort(tenant),
    checkCaddyRoute(tenant, adminApi),
  ]);
}
