import { ResultAsync, okAsync } from 'neverthrow';
import type { Tenant, RepairResult, LobsterError, LobsterdConfig } from '../types/index.js';
import * as network from '../system/network.js';
import * as caddy from '../system/caddy.js';

export function repairTap(tenant: Tenant): ResultAsync<RepairResult, LobsterError> {
  return network.createTap(tenant.tapDev, tenant.hostIp, tenant.ipAddress)
    .map((): RepairResult => ({
      repair: 'net.tap',
      fixed: true,
      actions: [`Recreated TAP device ${tenant.tapDev}`],
    }))
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: 'net.tap',
        fixed: false,
        actions: [`Failed to recreate TAP device ${tenant.tapDev}`],
      }),
    );
}

export function repairCaddyRoute(tenant: Tenant, config: LobsterdConfig): ResultAsync<RepairResult, LobsterError> {
  return caddy.addRoute(config.caddy.adminApi, tenant.name, config.caddy.domain, tenant.gatewayPort)
    .map((): RepairResult => ({
      repair: 'net.caddy-route',
      fixed: true,
      actions: [`Re-added Caddy route for ${tenant.name}.${config.caddy.domain}`],
    }))
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: 'net.caddy-route',
        fixed: false,
        actions: ['Failed to re-add Caddy route'],
      }),
    );
}
