import { okAsync, type ResultAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import * as network from "../system/network.js";
import type {
  LobsterdConfig,
  LobsterError,
  RepairResult,
  Tenant,
} from "../types/index.js";

export function repairTap(
  tenant: Tenant,
): ResultAsync<RepairResult, LobsterError> {
  return network
    .createTap(tenant.tapDev, tenant.hostIp, tenant.ipAddress)
    .andThen(() =>
      network.addNat(tenant.tapDev, tenant.ipAddress, tenant.gatewayPort),
    )
    .andThen(() => network.addIsolationRules(tenant.tapDev))
    .map(
      (): RepairResult => ({
        repair: "net.tap",
        fixed: true,
        actions: [
          `Recreated TAP device ${tenant.tapDev}`,
          "Restored NAT rules",
          "Restored network isolation rules",
        ],
      }),
    )
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: "net.tap",
        fixed: false,
        actions: [`Failed to recreate TAP device ${tenant.tapDev}`],
      }),
    );
}

export function repairCaddyRoute(
  tenant: Tenant,
  config: LobsterdConfig,
): ResultAsync<RepairResult, LobsterError> {
  return caddy
    .addRoute(
      config.caddy.adminApi,
      tenant.name,
      config.caddy.domain,
      tenant.ipAddress,
      9000,
    )
    .map(
      (): RepairResult => ({
        repair: "net.caddy-route",
        fixed: true,
        actions: [
          `Re-added Caddy route for ${tenant.name}.${config.caddy.domain}`,
        ],
      }),
    )
    .orElse(() =>
      okAsync<RepairResult, LobsterError>({
        repair: "net.caddy-route",
        fixed: false,
        actions: ["Failed to re-add Caddy route"],
      }),
    );
}
