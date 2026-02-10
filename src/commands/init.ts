import { errAsync, okAsync, ResultAsync } from 'neverthrow';
import { chmodSync } from 'node:fs';
import type { LobsterError, LobsterdConfig } from '../types/index.js';
import { exec, execUnchecked } from '../system/exec.js';
import * as network from '../system/network.js';
import * as caddy from '../system/caddy.js';
import {
  CONFIG_DIR, CONFIG_PATH, REGISTRY_PATH, DEFAULT_CONFIG, EMPTY_REGISTRY,
  LOBSTERD_BASE, OVERLAYS_DIR, SOCKETS_DIR, KERNELS_DIR,
} from '../config/defaults.js';

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

function checkKvm(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const devKvm = Bun.file('/dev/kvm');
      if (!(await devKvm.exists())) {
        throw new Error('/dev/kvm not found — KVM not available. Enable hardware virtualization in BIOS.');
      }
    })(),
    (e) => ({
      code: 'KVM_NOT_AVAILABLE' as const,
      message: e instanceof Error ? e.message : '/dev/kvm not accessible',
      cause: e,
    }),
  );
}

function checkFirecracker(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return execUnchecked(['test', '-x', config.firecracker.binaryPath]).andThen((r) => {
    if (r.exitCode !== 0) {
      return errAsync<void, LobsterError>({
        code: 'FIRECRACKER_NOT_FOUND',
        message: `Firecracker binary not found at ${config.firecracker.binaryPath}`,
      });
    }
    return okAsync(undefined);
  });
}

function checkKernel(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await Bun.file(config.firecracker.kernelPath).exists())) {
        throw new Error(`Kernel image not found at ${config.firecracker.kernelPath}`);
      }
    })(),
    (e) => ({
      code: 'FIRECRACKER_NOT_FOUND' as const,
      message: e instanceof Error ? e.message : 'Kernel image not found',
      cause: e,
    }),
  );
}

function checkRootfs(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await Bun.file(config.firecracker.rootfsPath).exists())) {
        throw new Error(`Root filesystem not found at ${config.firecracker.rootfsPath}`);
      }
    })(),
    (e) => ({
      code: 'FIRECRACKER_NOT_FOUND' as const,
      message: e instanceof Error ? e.message : 'Rootfs image not found',
      cause: e,
    }),
  );
}

function ensureDirs(): ResultAsync<void, LobsterError> {
  return exec(['mkdir', '-p', CONFIG_DIR, LOBSTERD_BASE, OVERLAYS_DIR, SOCKETS_DIR, KERNELS_DIR])
    .andThen(() => {
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

export interface InitResult {
  kvmAvailable: boolean;
  firecrackerFound: boolean;
  kernelFound: boolean;
  rootfsFound: boolean;
  dirsCreated: boolean;
  configCreated: boolean;
  ipForwardingEnabled: boolean;
  caddyConfigured: boolean;
}

export function runInit(config: LobsterdConfig = DEFAULT_CONFIG): ResultAsync<InitResult, LobsterError> {
  const result: InitResult = {
    kvmAvailable: false,
    firecrackerFound: false,
    kernelFound: false,
    rootfsFound: false,
    dirsCreated: false,
    configCreated: false,
    ipForwardingEnabled: false,
    caddyConfigured: false,
  };

  return checkLinux()
    .andThen(() => checkRoot())
    .andThen(() => checkKvm())
    .andThen(() => {
      result.kvmAvailable = true;
      return checkFirecracker(config);
    })
    .andThen(() => {
      result.firecrackerFound = true;
      return checkKernel(config);
    })
    .andThen(() => {
      result.kernelFound = true;
      return checkRootfs(config);
    })
    .andThen(() => {
      result.rootfsFound = true;
      return ensureDirs();
    })
    .andThen(() => {
      result.dirsCreated = true;
      return writeDefaultConfig();
    })
    .andThen(() => writeEmptyRegistry())
    .andThen(() => {
      result.configCreated = true;
      return network.enableIpForwarding();
    })
    .andThen(() => {
      result.ipForwardingEnabled = true;
      return caddy.ensureCaddyRunning();
    })
    .andThen(() => caddy.writeCaddyBaseConfig(config.caddy.adminApi, config.caddy.domain))
    .map(() => {
      result.caddyConfigured = true;
      return result;
    });
}
