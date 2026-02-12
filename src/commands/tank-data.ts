import { runAllChecks } from "../checks/index.js";
import * as vsock from "../system/vsock.js";
import type { LobsterdConfig, Tenant } from "../types/index.js";
import { initialWatchState, transition } from "../watchdog/state.js";

export interface TankEntry {
  name: string;
  cid: number;
  ip: string;
  port: number;
  vmPid: string;
  status: string;
  memoryMb?: number;
  state: string;
}

export function quickPidCheck(tenant: Tenant): string {
  if (!tenant.vmPid) {
    return "dead";
  }
  try {
    process.kill(tenant.vmPid, 0);
    return String(tenant.vmPid);
  } catch {
    return "dead";
  }
}

export async function buildTankEntries(
  tenants: Tenant[],
  config: LobsterdConfig,
): Promise<TankEntry[]> {
  return Promise.all(
    tenants.map(async (tenant) => {
      if (tenant.status === "suspended") {
        return {
          name: tenant.name,
          cid: tenant.cid,
          ip: tenant.ipAddress,
          port: tenant.gatewayPort,
          vmPid: "suspended",
          status: tenant.status,
          memoryMb: undefined,
          state: "SUSPENDED" as const,
        };
      }

      const pidStatus = quickPidCheck(tenant);
      let memoryMb: number | undefined;

      if (pidStatus !== "dead") {
        const stats = await vsock
          .getStats(tenant.ipAddress, config.vsock.agentPort, tenant.agentToken)
          .unwrapOr(undefined);
        if (stats && stats.memoryKb > 0) {
          memoryMb = Math.round(stats.memoryKb / 1024);
        }
      }

      const checkResult = await runAllChecks(tenant, config);
      const state = checkResult.isOk()
        ? transition(initialWatchState(), checkResult.value, config.watchdog)
            .next.state
        : "UNKNOWN";

      return {
        name: tenant.name,
        cid: tenant.cid,
        ip: tenant.ipAddress,
        port: tenant.gatewayPort,
        vmPid: pidStatus,
        status: tenant.status,
        memoryMb,
        state,
      };
    }),
  );
}
