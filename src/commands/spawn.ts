import { ok, errAsync, okAsync, ResultAsync } from 'neverthrow';
import { chmodSync } from 'node:fs';
import type { LobsterError, Tenant, TenantRegistry, LobsterdConfig } from '../types/index.js';
import { loadConfig, loadRegistry, saveRegistry } from '../config/loader.js';
import { TENANT_NAME_REGEX } from '../config/schema.js';
import * as zfs from '../system/zfs.js';
import * as user from '../system/user.js';
import * as docker from '../system/docker.js';
import * as systemd from '../system/systemd.js';
import * as firewall from '../system/firewall.js';
import * as nginx from '../system/nginx.js';
import { exec } from '../system/exec.js';

export interface SpawnProgress {
  step: string;
  detail: string;
}

type UndoFn = () => ResultAsync<void, LobsterError>;

export function runSpawn(
  name: string,
  onProgress?: (p: SpawnProgress) => void,
): ResultAsync<Tenant, LobsterError> {
  const progress = (step: string, detail: string) => onProgress?.({ step, detail });

  // ── Input validation ──────────────────────────────────────────────────
  if (!TENANT_NAME_REGEX.test(name)) {
    return errAsync({
      code: 'VALIDATION_FAILED',
      message: `Invalid tenant name "${name}": must match ${TENANT_NAME_REGEX}`,
    });
  }

  let config: LobsterdConfig;
  let registry: TenantRegistry;
  let tenant: Tenant;
  const undoStack: UndoFn[] = [];

  function rollback(error: LobsterError): ResultAsync<never, LobsterError> {
    if (undoStack.length === 0) return errAsync(error);
    const fns = [...undoStack].reverse();
    let count = 0;
    let chain: ResultAsync<void, LobsterError> = okAsync(undefined);
    for (const fn of fns) {
      chain = chain.andThen(() => fn().orElse(() => okAsync(undefined))).map(() => { count++; });
    }
    return chain.andThen(() =>
      errAsync({
        ...error,
        message: `${error.message} (rolled back ${count}/${fns.length} steps)`,
      }),
    );
  }

  return loadConfig()
    .andThen((c) => {
      config = c;
      return loadRegistry();
    })
    .andThen((r): ResultAsync<void, LobsterError> => {
      registry = r;

      if (registry.tenants.some((t) => t.name === name)) {
        return errAsync({ code: 'TENANT_EXISTS', message: `Tenant "${name}" already exists` });
      }

      const uid = registry.nextUid;
      const gid = uid;
      const gatewayPort = registry.nextGatewayPort;
      const dataset = `${config.zfs.parentDataset}/${name}`;
      const homePath = `${config.tenants.homeBase}/${name}`;

      tenant = {
        name,
        uid,
        gid,
        gatewayPort,
        zfsDataset: dataset,
        homePath,
        createdAt: new Date().toISOString(),
        status: 'active',
      };

      progress('zfs', `Creating dataset ${dataset}`);
      return zfs.createDataset(dataset, {
        mountpoint: homePath,
        quota: config.zfs.defaultQuota,
        compression: config.zfs.compression,
      });
    })
    .andThen(() => {
      undoStack.push(() => zfs.destroyDataset(tenant.zfsDataset, true));

      progress('user', `Creating user ${name} (uid ${tenant.uid})`);
      return user.createUser(name, tenant.uid, tenant.homePath);
    })
    .andThen(() => {
      undoStack.push(() => user.deleteUser(name));

      progress('permissions', `Setting ownership and permissions on ${tenant.homePath}`);
      return exec(['chown', `${tenant.uid}:${tenant.gid}`, tenant.homePath]).andThen(() => {
        chmodSync(tenant.homePath, 0o700);
        return okAsync(undefined);
      });
    })
    .andThen(() => {
      progress('subuid', 'Configuring subordinate UID/GID ranges');
      return user.ensureSubuidRange(name, tenant.uid * 65536);
    })
    .andThen(() => {
      progress('linger', 'Enabling loginctl linger');
      return user.enableLinger(name);
    })
    .andThen(() => {
      undoStack.push(() => user.disableLinger(name));

      progress('session', 'Waiting for user systemd session');
      return user.waitForUserSession(tenant.uid);
    })
    .andThen(() => {
      progress('dirs', 'Creating tenant directories');
      return exec(['sudo', '-u', name, '--', 'mkdir', '-p',
        `${tenant.homePath}/.config`,
        `${tenant.homePath}/.local/share`,
        `${tenant.homePath}/.openclaw`,
        `${tenant.homePath}/.openclaw/tmp`,
      ]).map(() => undefined);
    })
    .andThen(() => {
      progress('docker', 'Installing rootless Docker');
      return docker.installRootless(name, tenant.uid);
    })
    .andThen(() => {
      progress('docker-config', 'Writing Docker daemon.json');
      const dockerConfigDir = `${tenant.homePath}/.config/docker`;
      const daemonJson = `${dockerConfigDir}/daemon.json`;
      return ResultAsync.fromPromise(
        (async () => {
          await exec(['sudo', '-u', name, '--', 'mkdir', '-p', dockerConfigDir]);
          await Bun.write(daemonJson, JSON.stringify({ 'no-new-privileges': true }, null, 2) + '\n');
          chmodSync(daemonJson, 0o600);
          await exec(['chown', `${tenant.uid}:${tenant.gid}`, daemonJson]);
        })(),
        (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to write Docker daemon.json', cause: e }),
      );
    })
    .andThen(() => {
      progress('gateway-service', 'Creating OpenClaw gateway service');
      const token = crypto.randomUUID();
      tenant.gatewayToken = token;
      const serviceContent = `[Unit]
Description=OpenClaw Gateway for ${name}
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=${tenant.homePath}
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
Environment=XDG_RUNTIME_DIR=/run/user/${tenant.uid}
Environment=DOCKER_HOST=unix:///run/user/${tenant.uid}/docker.sock
Environment=NODE_ENV=production
Environment=TMPDIR=${tenant.homePath}/.openclaw/tmp
Environment=OPENCLAW_GATEWAY_TOKEN=${token}
ExecStart=/usr/bin/env node ${config.openclaw.installPath}/openclaw.mjs gateway --port ${tenant.gatewayPort} --auth token --bind loopback
Restart=on-failure
RestartSec=5
KillMode=process

[Install]
WantedBy=default.target
`;
      const servicePath = `${tenant.homePath}/.config/systemd/user/openclaw-gateway.service`;
      return ResultAsync.fromPromise(
        (async () => {
          await exec(['sudo', '-u', name, '--', 'mkdir', '-p', `${tenant.homePath}/.config/systemd/user`]);
          await Bun.write(servicePath, serviceContent);
          await exec(['chown', `${tenant.uid}:${tenant.gid}`, servicePath]);
        })(),
        (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to create gateway service', cause: e }),
      );
    })
    .andThen(() => {
      progress('openclaw-config', 'Writing OpenClaw config');
      const openclawConf = {
        ...config.openclaw.defaultConfig,
        gateway: {
          mode: 'local',
          tls: { enabled: false },
          controlUi: { enabled: false },
          auth: { token: tenant.gatewayToken },
          ...(config.openclaw.defaultConfig?.gateway as Record<string, unknown> ?? {}),
        },
      };
      return ResultAsync.fromPromise(
        (async () => {
          const confPath = `${tenant.homePath}/.openclaw/openclaw.json`;
          await Bun.write(confPath, JSON.stringify(openclawConf, null, 2) + '\n');
          chmodSync(confPath, 0o600);
          await exec(['chown', `${tenant.uid}:${tenant.gid}`, confPath]);
        })(),
        (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to write OpenClaw config', cause: e }),
      );
    })
    .andThen(() => {
      progress('services', 'Enabling and starting services');
      return systemd.daemonReload(name, tenant.uid)
        .andThen(() => systemd.enableService('docker', name, tenant.uid))
        .andThen(() => systemd.startService('docker', name, tenant.uid))
        .andThen(() => systemd.enableService('openclaw-gateway', name, tenant.uid))
        .andThen(() => systemd.startService('openclaw-gateway', name, tenant.uid));
    })
    .andThen(() => {
      progress('firewall', 'Adding iptables rules');
      return firewall.addTenantRules(tenant.uid, tenant.gatewayPort);
    })
    .andThen(() => {
      undoStack.push(() => firewall.removeTenantRules(tenant.uid, tenant.gatewayPort));

      progress('registry', 'Registering tenant');
      registry.tenants.push(tenant);
      registry.nextUid += 1;
      registry.nextGatewayPort += 1;
      return saveRegistry(registry);
    })
    .andThen(() => {
      progress('nginx', 'Updating Nginx routing');
      return nginx.updateTenantMap(registry).andThen(() => nginx.reloadNginx());
    })
    .map(() => tenant)
    .orElse((error) => rollback(error));
}
