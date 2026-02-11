import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  readFileSync,
} from "node:fs";
import { errAsync, okAsync, ResultAsync } from "neverthrow";
import {
  BUNDLED_CERTS_DIR,
  CERTS_DIR,
  CONFIG_DIR,
  CONFIG_PATH,
  DEFAULT_CONFIG,
  EMPTY_REGISTRY,
  JAILER_BASE,
  KERNELS_DIR,
  LOBSTERD_BASE,
  ORIGIN_CERT_PATH,
  ORIGIN_KEY_PATH,
  OVERLAYS_DIR,
  REGISTRY_PATH,
  SOCKETS_DIR,
} from "../config/defaults.js";
import * as caddy from "../system/caddy.js";
import { exec, execUnchecked } from "../system/exec.js";
import * as network from "../system/network.js";
import type { LobsterdConfig, LobsterError } from "../types/index.js";

function checkLinux(): ResultAsync<void, LobsterError> {
  if (process.platform !== "linux") {
    return errAsync({
      code: "NOT_LINUX" as const,
      message: `lobsterd requires Linux. Detected: ${process.platform}`,
    });
  }
  return okAsync(undefined);
}

function checkRoot(): ResultAsync<void, LobsterError> {
  if (process.getuid?.() !== 0) {
    return errAsync({
      code: "NOT_ROOT" as const,
      message: "lobster init must be run as root (or with sudo)",
    });
  }
  return okAsync(undefined);
}

function checkKvm(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      try {
        accessSync("/dev/kvm", fsConstants.R_OK | fsConstants.W_OK);
      } catch {
        throw new Error(
          "/dev/kvm not found — KVM not available. Enable hardware virtualization in BIOS.",
        );
      }
    })(),
    (e) => ({
      code: "KVM_NOT_AVAILABLE" as const,
      message: e instanceof Error ? e.message : "/dev/kvm not accessible",
      cause: e,
    }),
  );
}

function checkFirecracker(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return execUnchecked(["test", "-x", config.firecracker.binaryPath]).andThen(
    (r) => {
      if (r.exitCode !== 0) {
        return errAsync<void, LobsterError>({
          code: "FIRECRACKER_NOT_FOUND",
          message: `Firecracker binary not found at ${config.firecracker.binaryPath}`,
        });
      }
      return okAsync(undefined);
    },
  );
}

function checkJailer(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return execUnchecked(["test", "-x", config.jailer.binaryPath]).andThen(
    (r) => {
      if (r.exitCode !== 0) {
        return errAsync<void, LobsterError>({
          code: "JAILER_NOT_FOUND",
          message: `Jailer binary not found at ${config.jailer.binaryPath}`,
        });
      }
      return okAsync(undefined);
    },
  );
}

function checkKernel(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await Bun.file(config.firecracker.kernelPath).exists())) {
        throw new Error(
          `Kernel image not found at ${config.firecracker.kernelPath}`,
        );
      }
    })(),
    (e) => ({
      code: "FIRECRACKER_NOT_FOUND" as const,
      message: e instanceof Error ? e.message : "Kernel image not found",
      cause: e,
    }),
  );
}

function checkRootfs(config: LobsterdConfig): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await Bun.file(config.firecracker.rootfsPath).exists())) {
        throw new Error(
          `Root filesystem not found at ${config.firecracker.rootfsPath}`,
        );
      }
    })(),
    (e) => ({
      code: "FIRECRACKER_NOT_FOUND" as const,
      message: e instanceof Error ? e.message : "Rootfs image not found",
      cause: e,
    }),
  );
}

function ensureDirs(): ResultAsync<void, LobsterError> {
  return exec([
    "mkdir",
    "-p",
    CONFIG_DIR,
    CERTS_DIR,
    LOBSTERD_BASE,
    OVERLAYS_DIR,
    SOCKETS_DIR,
    KERNELS_DIR,
    JAILER_BASE,
  ]).andThen(() => {
    // 711: root rw, others can only traverse (needed for Caddy to reach certs/)
    chmodSync(CONFIG_DIR, 0o711);
    chmodSync(CERTS_DIR, 0o755);
    return okAsync(undefined);
  });
}

function installOriginCerts(): ResultAsync<boolean, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const bundledCert = Bun.file(`${BUNDLED_CERTS_DIR}/origin.pem`);
      const bundledKey = Bun.file(`${BUNDLED_CERTS_DIR}/origin-key.pem`);
      if (!(await bundledCert.exists()) || !(await bundledKey.exists())) {
        return false;
      }
      // Skip empty placeholder files
      if (bundledCert.size === 0 || bundledKey.size === 0) {
        return false;
      }
      await Bun.write(ORIGIN_CERT_PATH, bundledCert);
      await Bun.write(ORIGIN_KEY_PATH, bundledKey);
      chmodSync(ORIGIN_CERT_PATH, 0o644);
      chmodSync(ORIGIN_KEY_PATH, 0o640);
      // Caddy runs as user "caddy" and needs group-read access to the key
      const { execSync } = await import("node:child_process");
      try {
        execSync(`chown root:caddy ${ORIGIN_KEY_PATH}`);
      } catch {
        // Caddy group may not exist; fall back to world-readable
        chmodSync(ORIGIN_KEY_PATH, 0o644);
      }
      return true;
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to install origin certs",
      cause: e,
    }),
  );
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

function writeDefaultConfig(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(CONFIG_PATH))) {
        await Bun.write(
          CONFIG_PATH,
          `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`,
        );
        chmodSync(CONFIG_PATH, 0o600);
      }
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to write default config",
      cause: e,
    }),
  );
}

function writeEmptyRegistry(): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(REGISTRY_PATH))) {
        await Bun.write(
          REGISTRY_PATH,
          `${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`,
        );
        chmodSync(REGISTRY_PATH, 0o600);
      }
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: "Failed to write empty registry",
      cause: e,
    }),
  );
}

export interface InitResult {
  kvmAvailable: boolean;
  firecrackerFound: boolean;
  jailerFound: boolean;
  kernelFound: boolean;
  rootfsFound: boolean;
  dirsCreated: boolean;
  configCreated: boolean;
  certsInstalled: boolean;
  ipForwardingEnabled: boolean;
  caddyConfigured: boolean;
  warnings: string[];
}

export function runInit(
  initialConfig: LobsterdConfig = DEFAULT_CONFIG,
): ResultAsync<InitResult, LobsterError> {
  let config = initialConfig;
  const result: InitResult = {
    kvmAvailable: false,
    firecrackerFound: false,
    jailerFound: false,
    kernelFound: false,
    rootfsFound: false,
    dirsCreated: false,
    configCreated: false,
    certsInstalled: false,
    ipForwardingEnabled: false,
    caddyConfigured: false,
    warnings: [],
  };

  return checkLinux()
    .andThen(() => checkRoot())
    .andThen(() => checkKvm())
    .andThen(() => {
      result.kvmAvailable = true;

      // Check for insecure host configuration
      try {
        const smtActive = readFileSync(
          "/sys/devices/system/cpu/smt/active",
          "utf-8",
        ).trim();
        if (smtActive === "1") {
          result.warnings.push(
            'SMT is enabled — add "nosmt" to kernel boot parameters for side-channel protection',
          );
        }
      } catch {
        /* SMT file may not exist on single-core or non-x86 */
      }

      try {
        const ksmRun = readFileSync("/sys/kernel/mm/ksm/run", "utf-8").trim();
        if (ksmRun !== "0") {
          result.warnings.push(
            'KSM is active — run "echo 0 > /sys/kernel/mm/ksm/run" to prevent page dedup side-channels',
          );
        }
      } catch {
        /* KSM may not be available */
      }

      return okAsync(undefined);
    })
    .andThen(() => checkFirecracker(config))
    .andThen(() => {
      result.firecrackerFound = true;
      return checkJailer(config);
    })
    .andThen(() => {
      result.jailerFound = true;
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
      return installOriginCerts();
    })
    .andThen((installed) => {
      result.certsInstalled = installed;
      // If certs were installed and no TLS config was explicitly set, use them
      if (installed && !config.caddy.tls) {
        config = {
          ...config,
          caddy: {
            ...config.caddy,
            tls: { certPath: ORIGIN_CERT_PATH, keyPath: ORIGIN_KEY_PATH },
          },
        };
      }
      return network.enableIpForwarding();
    })
    .andThen(() => {
      result.ipForwardingEnabled = true;
      return network.ensureChains();
    })
    .andThen(() => {
      return caddy.ensureCaddyRunning();
    })
    .andThen(() =>
      caddy.writeCaddyBaseConfig(
        config.caddy.adminApi,
        config.caddy.domain,
        config.caddy.tls,
      ),
    )
    .map(() => {
      result.caddyConfigured = true;
      return result;
    });
}
