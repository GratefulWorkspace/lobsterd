import { okAsync, ResultAsync } from "neverthrow";
import * as caddy from "../system/caddy.js";
import { execUnchecked } from "../system/exec.js";
import type {
  HealthCheckResult,
  LobsterError,
  Tenant,
} from "../types/index.js";

export function checkTapDevice(
  tenant: Tenant,
): ResultAsync<HealthCheckResult, LobsterError> {
  return execUnchecked(["ip", "link", "show", tenant.tapDev])
    .map(
      (r): HealthCheckResult =>
        r.exitCode === 0
          ? {
              check: "net.tap",
              status: "ok",
              message: `TAP device ${tenant.tapDev} exists`,
            }
          : {
              check: "net.tap",
              status: "failed",
              message: `TAP device ${tenant.tapDev} not found`,
            },
    )
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: "net.tap",
        status: "failed",
        message: `Failed to check TAP device ${tenant.tapDev}`,
      }),
    );
}

export function checkGatewayPort(
  tenant: Tenant,
): ResultAsync<HealthCheckResult, LobsterError> {
  return ResultAsync.fromSafePromise(
    (async (): Promise<HealthCheckResult> => {
      try {
        const _socket = await Bun.connect({
          hostname: tenant.ipAddress,
          port: 9000,
          socket: {
            data() {},
            open(socket) {
              socket.end();
            },
            error() {},
          },
        });
        return {
          check: "net.gateway",
          status: "ok",
          message: `Gateway on ${tenant.ipAddress}:9000 is reachable`,
        };
      } catch {
        return {
          check: "net.gateway",
          status: "failed",
          message: `Gateway on ${tenant.ipAddress}:9000 is not reachable`,
        };
      }
    })(),
  );
}

export function checkCaddyRoute(
  tenant: Tenant,
  adminApi: string,
): ResultAsync<HealthCheckResult, LobsterError> {
  return caddy
    .listRoutes(adminApi)
    .map((routes): HealthCheckResult => {
      const found = routes.some(
        (r) =>
          (r as Record<string, unknown>)?.["@id"] === `lobster-${tenant.name}`,
      );
      return found
        ? {
            check: "net.caddy-route",
            status: "ok",
            message: `Caddy route lobster-${tenant.name} exists`,
          }
        : {
            check: "net.caddy-route",
            status: "failed",
            message: `Caddy route lobster-${tenant.name} not found`,
          };
    })
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: "net.caddy-route",
        status: "failed",
        message: "Failed to query Caddy routes",
      }),
    );
}

export function runNetworkChecks(
  tenant: Tenant,
  adminApi: string,
): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkTapDevice(tenant),
    checkGatewayPort(tenant),
    checkCaddyRoute(tenant, adminApi),
  ]);
}
