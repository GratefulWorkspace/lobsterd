import { ResultAsync, okAsync } from 'neverthrow';
import type { Tenant, HealthCheckResult, LobsterError } from '../types/index.js';
import * as vsock from '../system/vsock.js';

export function checkVmProcess(tenant: Tenant): ResultAsync<HealthCheckResult, LobsterError> {
  return ResultAsync.fromSafePromise(
    (async (): Promise<HealthCheckResult> => {
      if (!tenant.vmPid) {
        return { check: 'vm.process', status: 'failed', message: 'No VM PID recorded' };
      }
      try {
        process.kill(tenant.vmPid, 0);
        return { check: 'vm.process', status: 'ok', message: `VM process ${tenant.vmPid} is alive` };
      } catch {
        return { check: 'vm.process', status: 'failed', message: `VM process ${tenant.vmPid} is dead` };
      }
    })(),
  );
}

export function checkVmResponsive(tenant: Tenant, healthPort: number): ResultAsync<HealthCheckResult, LobsterError> {
  return vsock.healthPing(tenant.ipAddress, healthPort, tenant.agentToken)
    .map((ok): HealthCheckResult =>
      ok
        ? { check: 'vm.responsive', status: 'ok', message: 'Guest agent responded to health ping' }
        : { check: 'vm.responsive', status: 'failed', message: 'Guest agent did not respond' },
    )
    .orElse(() =>
      okAsync<HealthCheckResult, LobsterError>({
        check: 'vm.responsive',
        status: 'failed',
        message: 'Could not reach guest agent via TCP',
      }),
    );
}

export function runVmChecks(tenant: Tenant, healthPort: number): ResultAsync<HealthCheckResult[], LobsterError> {
  return ResultAsync.combine([
    checkVmProcess(tenant),
    checkVmResponsive(tenant, healthPort),
  ]);
}
