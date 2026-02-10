import { ok, errAsync, okAsync, ResultAsync } from 'neverthrow';
import type { LobsterError, Tenant, TenantRegistry, LobsterdConfig } from '../types/index.js';
import { loadConfig, loadRegistry, saveRegistry } from '../config/loader.js';
import * as zfs from '../system/zfs.js';
import * as user from '../system/user.js';
import * as docker from '../system/docker.js';
import * as systemd from '../system/systemd.js';
import { exec } from '../system/exec.js';

export interface SpawnProgress {
  step: string;
  detail: string;
}

export function runSpawn(
  name: string,
  onProgress?: (p: SpawnProgress) => void,
): ResultAsync<Tenant, LobsterError> {
  const progress = (step: string, detail: string) => onProgress?.({ step, detail });

  let config: LobsterdConfig;
  let registry: TenantRegistry;
  let tenant: Tenant;

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
      progress('user', `Creating user ${name} (uid ${tenant.uid})`);
      return user.createUser(name, tenant.uid, tenant.homePath);
    })
    .andThen(() => {
      progress('permissions', `Setting ownership on ${tenant.homePath}`);
      return exec(['chown', `${tenant.uid}:${tenant.gid}`, tenant.homePath]).map(() => undefined);
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
      progress('session', 'Waiting for user systemd session');
      return user.waitForUserSession(tenant.uid);
    })
    .andThen(() => {
      progress('dirs', 'Creating .config and .local directories');
      return exec(['sudo', '-u', name, '--', 'mkdir', '-p',
        `${tenant.homePath}/.config`,
        `${tenant.homePath}/.local/share`,
        `${tenant.homePath}/.openclaw`,
      ]).map(() => undefined);
    })
    .andThen(() => {
      progress('docker', 'Installing rootless Docker');
      return docker.installRootless(name, tenant.uid);
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
Environment=OPENCLAW_GATEWAY_TOKEN=${token}
ExecStart=/usr/bin/env node ${config.openclaw.installPath}/openclaw.mjs gateway --port ${tenant.gatewayPort} --auth token --bind lan --allow-unconfigured
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
          tls: { enabled: true },
          auth: { token: tenant.gatewayToken },
          controlUi: { dangerouslyDisableDeviceAuth: true },
          ...(config.openclaw.defaultConfig?.gateway as Record<string, unknown> ?? {}),
        },
      };
      return ResultAsync.fromPromise(
        (async () => {
          const confPath = `${tenant.homePath}/.openclaw/openclaw.json`;
          await Bun.write(confPath, JSON.stringify(openclawConf, null, 2) + '\n');
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
      progress('registry', 'Registering tenant');
      registry.tenants.push(tenant);
      registry.nextUid += 1;
      registry.nextGatewayPort += 1;
      return saveRegistry(registry);
    })
    .map(() => tenant);
}
