import { ok, err, errAsync, okAsync, ResultAsync } from 'neverthrow';
import { chmodSync } from 'node:fs';
import type { LobsterError, LobsterdConfig } from '../types/index.js';
import { exec, execUnchecked } from '../system/exec.js';
import * as zfs from '../system/zfs.js';
import * as firewall from '../system/firewall.js';
import * as nginx from '../system/nginx.js';
import { CONFIG_DIR, CONFIG_PATH, REGISTRY_PATH, DEFAULT_CONFIG, EMPTY_REGISTRY } from '../config/defaults.js';

function checkLinux(): ResultAsync<void, LobsterError> {
  if (process.platform !== 'linux') {
    return errAsync({ code: 'NOT_LINUX' as const, message: 'lobsterd requires Linux. Detected: ' + process.platform });
  }
  return okAsync(undefined);
}

function checkRoot(): ResultAsync<void, LobsterError> {
  if (process.getuid?.() !== 0) {
    return errAsync({ code: 'NOT_ROOT' as const, message: 'lobster init must be run as root (or with sudo)' });
  }
  return okAsync(undefined);
}

function checkKernel(): ResultAsync<string, LobsterError> {
  return exec(['uname', '-r']).map((r) => {
    const version = r.stdout.trim();
    const [major, minor] = version.split('.').map(Number);
    if (major < 5 || (major === 5 && minor < 11)) {
      throw new Error(`Kernel ${version} too old — need >= 5.11 for rootless Docker features`);
    }
    return version;
  });
}

function checkDocker(): ResultAsync<void, LobsterError> {
  return execUnchecked(['which', 'dockerd']).andThen((r) => {
    if (r.exitCode !== 0) {
      return errAsync<void, LobsterError>({ code: 'DOCKER_NOT_INSTALLED', message: 'Docker is not installed. Install Docker Engine first.' });
    }
    return okAsync(undefined);
  });
}

function ensureConfigDir(): ResultAsync<void, LobsterError> {
  return exec(['mkdir', '-p', CONFIG_DIR]).andThen(() => {
    chmodSync(CONFIG_DIR, 0o700);
    return okAsync(undefined);
  });
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

function writeDefaultConfig(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(CONFIG_PATH))) {
        await Bun.write(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
        chmodSync(CONFIG_PATH, 0o600);
      }
    })(),
    (e) => ({ code: 'EXEC_FAILED' as const, message: 'Failed to write default config', cause: e }),
  );
}

function writeEmptyRegistry(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(REGISTRY_PATH))) {
        await Bun.write(REGISTRY_PATH, JSON.stringify(EMPTY_REGISTRY, null, 2) + '\n');
        chmodSync(REGISTRY_PATH, 0o600);
      }
    })(),
    (e) => ({ code: 'EXEC_FAILED' as const, message: 'Failed to write empty registry', cause: e }),
  );
}

function hardenProcfs(): ResultAsync<void, LobsterError> {
  return execUnchecked(['mount', '-o', 'remount,hidepid=invisible', '/proc']).andThen((r) => {
    if (r.exitCode === 0) return okAsync(undefined);
    // Fall back to hidepid=2 on older kernels
    return exec(['mount', '-o', 'remount,hidepid=2', '/proc']).map(() => undefined);
  });
}

export interface InitResult {
  kernel: string;
  zfsAvailable: boolean;
  parentDatasetCreated: boolean;
  configCreated: boolean;
  procfsHardened: boolean;
  firewallInitialized: boolean;
  nginxConfigured: boolean;
}

export function runInit(config: LobsterdConfig = DEFAULT_CONFIG): ResultAsync<InitResult, LobsterError> {
  const result: InitResult = {
    kernel: '',
    zfsAvailable: false,
    parentDatasetCreated: false,
    configCreated: false,
    procfsHardened: false,
    firewallInitialized: false,
    nginxConfigured: false,
  };

  return checkLinux()
    .andThen(() => checkRoot())
    .andThen(() => checkKernel())
    .andThen((kernel) => {
      result.kernel = kernel;
      return zfs.isZfsAvailable();
    })
    .andThen((available): ResultAsync<void, LobsterError> => {
      result.zfsAvailable = available;
      if (!available) {
        return errAsync({
          code: 'ZFS_NOT_AVAILABLE',
          message: 'ZFS is not available. Install ZFS and create a pool first.',
        });
      }
      return okAsync(undefined);
    })
    .andThen(() => zfs.datasetExists(config.zfs.parentDataset))
    .andThen((exists): ResultAsync<void, LobsterError> => {
      if (!exists) {
        result.parentDatasetCreated = true;
        return zfs.createDataset(config.zfs.parentDataset, {
          compression: config.zfs.compression,
        });
      }
      return okAsync(undefined);
    })
    .andThen(() => checkDocker())
    .andThen(() => ensureConfigDir())
    .andThen(() => writeDefaultConfig())
    .andThen(() => {
      result.configCreated = true;
      return writeEmptyRegistry();
    })
    .andThen(() => hardenProcfs())
    .andThen(() => {
      result.procfsHardened = true;
      return firewall.initFirewall();
    })
    .andThen(() => {
      result.firewallInitialized = true;
      return nginx.ensureNginxInstalled();
    })
    .andThen(() => nginx.addFirewallBypass())
    .andThen(() => exec(['mkdir', '-p', '/etc/lobsterd/nginx']))
    .andThen(() => nginx.generateWildcardCert())
    .andThen(() => nginx.writeBaseConfig())
    .andThen(() => nginx.updateTenantMap(EMPTY_REGISTRY))
    .andThen(() => nginx.ensureNginxRunning())
    .map(() => {
      result.nginxConfigured = true;
      return result;
    });
}
