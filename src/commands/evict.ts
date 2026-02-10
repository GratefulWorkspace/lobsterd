import { ok, errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant, TenantRegistry } from '../types/index.js';
import { loadRegistry, saveRegistry } from '../config/loader.js';
import * as zfs from '../system/zfs.js';
import * as user from '../system/user.js';
import * as systemd from '../system/systemd.js';
import * as firewall from '../system/firewall.js';
import * as nginx from '../system/nginx.js';

export interface EvictProgress {
  step: string;
  detail: string;
}

export function runEvict(
  name: string,
  onProgress?: (p: EvictProgress) => void,
): ResultAsync<void, LobsterError> {
  const progress = (step: string, detail: string) => onProgress?.({ step, detail });
  let tenant: Tenant;
  let registry: TenantRegistry;

  return loadRegistry()
    .andThen((reg): ResultAsync<void, LobsterError> => {
      const found = reg.tenants.find((t) => t.name === name);
      if (!found) {
        return errAsync({ code: 'TENANT_NOT_FOUND', message: `Tenant "${name}" not found` });
      }
      tenant = found;
      registry = reg;

      found.status = 'removing';
      return saveRegistry(reg);
    })
    .andThen(() => {
      progress('services', 'Stopping services');
      return systemd.stopService('openclaw-gateway', name, tenant.uid)
        .orElse(() => okAsync(undefined))
        .andThen(() => systemd.stopService('docker', name, tenant.uid))
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      progress('firewall', 'Removing firewall rules');
      return firewall.removeTenantRules(tenant.uid, tenant.gatewayPort)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      progress('zfs', `Destroying dataset ${tenant.zfsDataset}`);
      return zfs.destroyDataset(tenant.zfsDataset, true)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      progress('linger', 'Disabling linger');
      return user.disableLinger(name)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      progress('user', `Deleting user ${name}`);
      return user.deleteUser(name)
        .orElse(() => okAsync(undefined));
    })
    .andThen(() => {
      progress('registry', 'Removing from registry');
      registry.tenants = registry.tenants.filter((t) => t.name !== name);
      return saveRegistry(registry);
    })
    .andThen(() => {
      progress('nginx', 'Updating Nginx routing');
      return nginx.updateTenantMap(registry)
        .andThen(() => nginx.reloadNginx())
        .orElse(() => okAsync(undefined));
    });
}
