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

// ── types ───────────────────────────────────────────────────────────────────

export interface PreflightResult {
  missing: {
    firecracker: boolean;
    kernel: boolean;
    rootfs: boolean;
    caddy: boolean;
  };
  caddyPackageManager: string | null;
  warnings: string[];
}

export interface InitOpts {
  domain?: string;
  install: {
    firecracker: boolean;
    kernel: boolean;
    rootfs: boolean;
    caddy: boolean;
  };
}

// ── prerequisite checks ─────────────────────────────────────────────────────

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

// ── preflight ───────────────────────────────────────────────────────────────

export function preflight(
  config: LobsterdConfig,
): ResultAsync<PreflightResult, LobsterError> {
  return checkLinux()
    .andThen(() => checkRoot())
    .andThen(() => checkKvm())
    .andThen(() =>
      ResultAsync.fromPromise(
        (async () => {
          const warnings: string[] = [];

          // Check for insecure host configuration
          try {
            const smtActive = readFileSync(
              "/sys/devices/system/cpu/smt/active",
              "utf-8",
            ).trim();
            if (smtActive === "1") {
              warnings.push(
                'SMT is enabled — add "nosmt" to kernel boot parameters for side-channel protection',
              );
            }
          } catch {
            /* SMT file may not exist on single-core or non-x86 */
          }

          try {
            const ksmRun = readFileSync(
              "/sys/kernel/mm/ksm/run",
              "utf-8",
            ).trim();
            if (ksmRun !== "0") {
              warnings.push(
                'KSM is active — run "echo 0 > /sys/kernel/mm/ksm/run" to prevent page dedup side-channels',
              );
            }
          } catch {
            /* KSM may not be available */
          }

          // Scan for missing deps
          const fcResult = await execUnchecked([
            "test",
            "-x",
            config.firecracker.binaryPath,
          ]);
          const jailerResult = await execUnchecked([
            "test",
            "-x",
            config.jailer.binaryPath,
          ]);
          const missingFirecracker =
            fcResult.isErr() ||
            fcResult.value.exitCode !== 0 ||
            jailerResult.isErr() ||
            jailerResult.value.exitCode !== 0;

          const missingKernel = !(await Bun.file(
            config.firecracker.kernelPath,
          ).exists());
          const missingRootfs = !(await Bun.file(
            config.firecracker.rootfsPath,
          ).exists());

          const caddyResult = await execUnchecked(["which", "caddy"]);
          const missingCaddy =
            caddyResult.isErr() || caddyResult.value.exitCode !== 0;

          // Detect package manager for Caddy if missing
          let caddyPackageManager: string | null = null;
          if (missingCaddy) {
            const managers = ["apt-get", "dnf", "yum", "pacman"] as const;
            for (const m of managers) {
              const result = await execUnchecked(["which", m]);
              if (result.isOk() && result.value.exitCode === 0) {
                caddyPackageManager = m;
                break;
              }
            }
          }

          return {
            missing: {
              firecracker: missingFirecracker,
              kernel: missingKernel,
              rootfs: missingRootfs,
              caddy: missingCaddy,
            },
            caddyPackageManager,
            warnings,
          } satisfies PreflightResult;
        })(),
        (e) => ({
          code: "EXEC_FAILED" as const,
          message: `Preflight check failed: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      ),
    );
}

// ── pure install helpers ────────────────────────────────────────────────────

const FC_VERSION = "1.14.1";
const KERNEL_VERSION = "6.1.155";
const FC_MINOR = "1.14";

export function installFirecracker(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  const arch = process.arch === "x64" ? "x86_64" : process.arch;
  const tarUrl = `https://github.com/firecracker-microvm/firecracker/releases/download/v${FC_VERSION}/firecracker-v${FC_VERSION}-${arch}.tgz`;
  return exec(["curl", "-fSL", tarUrl, "-o", "/tmp/firecracker.tgz"], {
    timeout: 120_000,
  })
    .andThen(() => exec(["tar", "xzf", "/tmp/firecracker.tgz", "-C", "/tmp"]))
    .andThen(() => {
      const prefix = `/tmp/release-v${FC_VERSION}-${arch}`;
      return exec([
        "install",
        "-m",
        "0755",
        `${prefix}/firecracker-v${FC_VERSION}-${arch}`,
        config.firecracker.binaryPath,
      ]).andThen(() =>
        exec([
          "install",
          "-m",
          "0755",
          `${prefix}/jailer-v${FC_VERSION}-${arch}`,
          config.jailer.binaryPath,
        ]),
      );
    })
    .andThen(() =>
      exec([
        "rm",
        "-rf",
        "/tmp/firecracker.tgz",
        `/tmp/release-v${FC_VERSION}-${arch}`,
      ]),
    )
    .map(() => undefined);
}

export function installKernel(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  const kernelUrl = `https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v${FC_MINOR}/x86_64/vmlinux-${KERNEL_VERSION}`;
  return exec(["mkdir", "-p", KERNELS_DIR])
    .andThen(() =>
      exec(["curl", "-fSL", kernelUrl, "-o", config.firecracker.kernelPath], {
        timeout: 120_000,
      }),
    )
    .map(() => undefined);
}

export function installRootfs(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  const scriptDir = new URL("../../guest", import.meta.url).pathname;
  return exec(["bash", `${scriptDir}/build-rootfs.sh`], {
    timeout: 600_000,
  })
    .andThen(() =>
      exec(["mv", `${scriptDir}/rootfs.ext4`, config.firecracker.rootfsPath]),
    )
    .map(() => undefined);
}

export function installCaddy(pm: string): ResultAsync<void, LobsterError> {
  const installCmd =
    pm === "pacman"
      ? ["pacman", "-S", "--noconfirm", "caddy"]
      : [pm, "install", "-y", "caddy"];
  return exec(installCmd, { timeout: 120_000 }).map(() => undefined);
}

// ── directory / config / cert helpers ───────────────────────────────────────

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
      if (bundledCert.size === 0 || bundledKey.size === 0) {
        return false;
      }
      await Bun.write(ORIGIN_CERT_PATH, bundledCert);
      await Bun.write(ORIGIN_KEY_PATH, bundledKey);
      chmodSync(ORIGIN_CERT_PATH, 0o644);
      chmodSync(ORIGIN_KEY_PATH, 0o640);
      const { execSync } = await import("node:child_process");
      try {
        execSync(`chown root:caddy ${ORIGIN_KEY_PATH}`);
      } catch {
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

function writeDefaultConfig(
  config: LobsterdConfig,
): ResultAsync<void, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      if (!(await fileExists(CONFIG_PATH))) {
        await Bun.write(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
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

// ── public interface ────────────────────────────────────────────────────────

export interface InitResult {
  kvmAvailable: boolean;
  firecrackerInstalled: boolean;
  kernelInstalled: boolean;
  rootfsInstalled: boolean;
  dirsCreated: boolean;
  configCreated: boolean;
  certsInstalled: boolean;
  ipForwardingEnabled: boolean;
  caddyInstalled: boolean;
  caddyConfigured: boolean;
  warnings: string[];
}

export function runInit(
  initialConfig: LobsterdConfig = DEFAULT_CONFIG,
  opts: InitOpts,
): ResultAsync<InitResult, LobsterError> {
  let config = initialConfig;
  if (opts.domain) {
    config = { ...config, caddy: { ...config.caddy, domain: opts.domain } };
  }

  const result: InitResult = {
    kvmAvailable: true,
    firecrackerInstalled: false,
    kernelInstalled: false,
    rootfsInstalled: false,
    dirsCreated: false,
    configCreated: false,
    certsInstalled: false,
    ipForwardingEnabled: false,
    caddyInstalled: false,
    caddyConfigured: false,
    warnings: [],
  };

  // Start the chain — preflight already validated Linux/root/KVM
  let chain: ResultAsync<void, LobsterError> = okAsync(undefined);

  // Install deps based on flags
  if (opts.install.firecracker) {
    chain = chain
      .andThen(() => installFirecracker(config))
      .andThen(() => {
        result.firecrackerInstalled = true;
        return okAsync(undefined);
      });
  }

  if (opts.install.kernel) {
    chain = chain
      .andThen(() => installKernel(config))
      .andThen(() => {
        result.kernelInstalled = true;
        return okAsync(undefined);
      });
  }

  if (opts.install.rootfs) {
    chain = chain
      .andThen(() => installRootfs(config))
      .andThen(() => {
        result.rootfsInstalled = true;
        return okAsync(undefined);
      });
  }

  if (opts.install.caddy) {
    chain = chain
      .andThen(() => {
        return ResultAsync.fromPromise(
          (async () => {
            const managers = ["apt-get", "dnf", "yum", "pacman"] as const;
            for (const m of managers) {
              const r = await execUnchecked(["which", m]);
              if (r.isOk() && r.value.exitCode === 0) {
                return m;
              }
            }
            throw new Error(
              "No supported package manager detected (apt-get, dnf, yum, pacman)",
            );
          })(),
          (e) => ({
            code: "EXEC_FAILED" as const,
            message:
              e instanceof Error
                ? e.message
                : "Failed to detect package manager",
            cause: e,
          }),
        );
      })
      .andThen((pm) => installCaddy(pm))
      .andThen(() => {
        result.caddyInstalled = true;
        return okAsync(undefined);
      });
  }

  // Dirs, config, certs, networking, caddy config
  return chain
    .andThen(() => ensureDirs())
    .andThen(() => {
      result.dirsCreated = true;
      return writeDefaultConfig(config);
    })
    .andThen(() => writeEmptyRegistry())
    .andThen(() => {
      result.configCreated = true;
      return installOriginCerts();
    })
    .andThen((installed) => {
      result.certsInstalled = installed;
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
    .andThen(() => caddy.ensureCaddyRunning())
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
