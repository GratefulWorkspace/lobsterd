import { okAsync, ResultAsync } from 'neverthrow';
import { chmodSync } from 'node:fs';
import type { LobsterError, TenantRegistry } from '../types/index.js';
import { exec, execUnchecked } from './exec.js';

const NGINX_DIR = '/etc/lobsterd/nginx';
const CERT_PATH = `${NGINX_DIR}/wildcard.crt`;
const KEY_PATH = `${NGINX_DIR}/wildcard.key`;
const TENANT_MAP_PATH = `${NGINX_DIR}/tenant-map.conf`;
const SITE_CONFIG_PATH = '/etc/nginx/sites-enabled/lobsterd.conf';
const DEFAULT_SITE_PATH = '/etc/nginx/sites-enabled/default';

export function ensureNginxInstalled(): ResultAsync<void, LobsterError> {
  return execUnchecked(['which', 'nginx']).andThen((r): ResultAsync<void, LobsterError> => {
    if (r.exitCode !== 0) {
      return exec(['apt-get', 'install', '-y', 'nginx'], { timeout: 120_000 }).map(() => undefined);
    }
    return okAsync(undefined);
  });
}

export function generateWildcardCert(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    Bun.file(CERT_PATH).exists(),
    (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to check cert existence', cause: e }),
  ).andThen((exists): ResultAsync<void, LobsterError> => {
    if (exists) return okAsync(undefined);
    return exec([
      'openssl', 'req', '-x509', '-nodes', '-days', '3650',
      '-newkey', 'rsa:2048',
      '-keyout', KEY_PATH,
      '-out', CERT_PATH,
      '-subj', '/CN=*.lobster.local',
      '-addext', 'subjectAltName=DNS:*.lobster.local,DNS:lobster.local',
    ]).andThen(() => {
      chmodSync(KEY_PATH, 0o600);
      return okAsync(undefined);
    });
  });
}

export function writeBaseConfig(): ResultAsync<void, LobsterError> {
  const config = `map $host $tenant_port {
    include ${TENANT_MAP_PATH};
}

server {
    listen 443 ssl;
    server_name *.lobster.local;

    ssl_certificate ${CERT_PATH};
    ssl_certificate_key ${KEY_PATH};

    location / {
        if ($tenant_port = "") {
            return 502;
        }

        proxy_pass http://127.0.0.1:$tenant_port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
`;

  return ResultAsync.fromPromise(
    (async () => {
      await Bun.write(SITE_CONFIG_PATH, config);
      // Remove default site if it exists
      try {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(DEFAULT_SITE_PATH);
      } catch {
        // Already removed or doesn't exist
      }
    })(),
    (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to write Nginx config', cause: e }),
  );
}

export function updateTenantMap(registry: TenantRegistry): ResultAsync<void, LobsterError> {
  const activeTenants = registry.tenants.filter((t) => t.status === 'active');

  let content: string;
  if (activeTenants.length === 0) {
    content = '# empty\n';
  } else {
    content = activeTenants
      .map((t) => `${t.name}.lobster.local ${t.gatewayPort};`)
      .join('\n') + '\n';
  }

  return ResultAsync.fromPromise(
    (async () => {
      const tmpPath = `${TENANT_MAP_PATH}.tmp.${process.pid}`;
      await Bun.write(tmpPath, content);
      const proc = Bun.spawn(['mv', tmpPath, TENANT_MAP_PATH]);
      await proc.exited;
      if (proc.exitCode !== 0) {
        throw new Error(`mv failed with exit code ${proc.exitCode}`);
      }
    })(),
    (e): LobsterError => ({ code: 'EXEC_FAILED', message: 'Failed to write tenant map', cause: e }),
  );
}

export function reloadNginx(): ResultAsync<void, LobsterError> {
  return exec(['nginx', '-s', 'reload']).map(() => undefined);
}

export function addFirewallBypass(): ResultAsync<void, LobsterError> {
  // Nginx workers run as www-data — allow them through the LOBSTER firewall chain
  // so they can proxy to tenant gateway ports on loopback.
  return exec(['id', '-u', 'www-data']).andThen((r) => {
    const uid = r.stdout.trim();
    return execUnchecked(['iptables', '-C', 'LOBSTER', '-m', 'owner', '--uid-owner', uid, '-j', 'RETURN'])
      .andThen((check): ResultAsync<void, LobsterError> => {
        if (check.exitCode !== 0) {
          // Insert at position 2 (after root UID 0 bypass) so it precedes per-tenant DROP rules
          return exec(['iptables', '-I', 'LOBSTER', '2', '-m', 'owner', '--uid-owner', uid, '-j', 'RETURN']).map(() => undefined);
        }
        return okAsync(undefined);
      });
  });
}

export function ensureNginxRunning(): ResultAsync<void, LobsterError> {
  return exec(['systemctl', 'enable', '--now', 'nginx']).map(() => undefined);
}
