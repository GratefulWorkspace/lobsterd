import type {
  BuoyConfig,
  LobsterdConfig,
  TenantRegistry,
} from "../types/index.js";

export const CONFIG_DIR = "/etc/lobsterd";
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
export const REGISTRY_PATH = `${CONFIG_DIR}/registry.json`;

export const LOBSTERD_BASE = "/var/lib/lobsterd";
export const OVERLAYS_DIR = `${LOBSTERD_BASE}/overlays`;
export const SOCKETS_DIR = `${LOBSTERD_BASE}/sockets`;
export const KERNELS_DIR = `${LOBSTERD_BASE}/kernels`;
export const JAILER_BASE = `${LOBSTERD_BASE}/jailer`;
export const CERTS_DIR = `${CONFIG_DIR}/certs`;
export const ORIGIN_CERT_PATH = `${CERTS_DIR}/origin.pem`;
export const ORIGIN_KEY_PATH = `${CERTS_DIR}/origin-key.pem`;

// Bundled cert sources (relative to project root)
export const BUNDLED_CERTS_DIR = new URL("../../certs", import.meta.url)
  .pathname;

export const DEFAULT_CONFIG: LobsterdConfig = {
  jailer: {
    binaryPath: "/usr/local/bin/jailer",
    chrootBaseDir: JAILER_BASE,
    uidStart: 10000,
  },
  firecracker: {
    binaryPath: "/usr/local/bin/firecracker",
    kernelPath: `${KERNELS_DIR}/vmlinux`,
    rootfsPath: `${LOBSTERD_BASE}/rootfs.ext4`,
    defaultVcpuCount: 2,
    defaultMemSizeMb: 512,
    networkRxRateLimit: {
      bandwidth: { size: 1_250_000, refillTime: 1000 },
      ops: { size: 1_000, refillTime: 1000 },
    },
    networkTxRateLimit: {
      bandwidth: { size: 1_250_000, refillTime: 1000 },
      ops: { size: 1_000, refillTime: 1000 },
    },
    diskRateLimit: {
      bandwidth: { size: 52_428_800, refillTime: 1000 },
      ops: { size: 5_000, refillTime: 1000 },
    },
  },
  network: {
    bridgeName: "lobster0",
    subnetBase: "10.0.0.0",
    subnetMask: 30,
    gatewayPortStart: 9000,
  },
  caddy: {
    adminApi: "http://localhost:2019",
    domain: "lobster.local",
  },
  vsock: {
    agentPort: 52,
    connectTimeoutMs: 30_000,
    healthPort: 53,
  },
  overlay: {
    baseDir: OVERLAYS_DIR,
    defaultSizeMb: 4096,
    snapshotRetention: 7,
  },
  watchdog: {
    intervalMs: 30_000,
    maxRepairAttempts: 3,
    repairCooldownMs: 60_000,
  },
  openclaw: {
    installPath: "/opt/openclaw",
    defaultConfig: {
      gateway: {
        mode: "local",
        bind: "custom",
        auth: {
          mode: "token",
        },
        controlUi: {
          allowedOrigins: ["http://localhost:5173"],
          dangerouslyDisableDeviceAuth: true,
        },
      },
    },
  },
};

export const DEFAULT_BUOY_CONFIG: BuoyConfig = {
  port: 7070,
  host: "127.0.0.1",
  apiToken: "",
  agentLockdown: true,
};

export const EMPTY_REGISTRY: TenantRegistry = {
  tenants: [],
  nextCid: 3,
  nextSubnetIndex: 1,
  nextGatewayPort: DEFAULT_CONFIG.network.gatewayPortStart,
  nextJailUid: DEFAULT_CONFIG.jailer.uidStart,
};
