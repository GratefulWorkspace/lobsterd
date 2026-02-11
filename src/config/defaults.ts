import type { LobsterdConfig, TenantRegistry } from '../types/index.js';

export const CONFIG_DIR = '/etc/lobsterd';
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
export const REGISTRY_PATH = `${CONFIG_DIR}/registry.json`;

export const LOBSTERD_BASE = '/var/lib/lobsterd';
export const OVERLAYS_DIR = `${LOBSTERD_BASE}/overlays`;
export const SOCKETS_DIR = `${LOBSTERD_BASE}/sockets`;
export const KERNELS_DIR = `${LOBSTERD_BASE}/kernels`;

export const DEFAULT_CONFIG: LobsterdConfig = {
  firecracker: {
    binaryPath: '/usr/local/bin/firecracker',
    kernelPath: `${KERNELS_DIR}/vmlinux`,
    rootfsPath: `${LOBSTERD_BASE}/rootfs.ext4`,
    defaultVcpuCount: 2,
    defaultMemSizeMb: 2048,
  },
  network: {
    bridgeName: 'lobster0',
    subnetBase: '10.0.0.0',
    subnetMask: 30,
    gatewayPortStart: 9000,
  },
  caddy: {
    adminApi: 'http://localhost:2019',
    domain: 'lobster.local',
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
    installPath: '/opt/openclaw',
    defaultConfig: {
      gateway: {
        mode: 'local',
        bind: 'lan',
        auth: {
          mode: 'token',
        },
      },
      models: {
        providers: {
          fireworks: {
            baseUrl: 'https://api.fireworks.ai/inference/v1',
            apiKey: 'fw_SM5UK6FtmAhA15UYscdTXk',
            api: 'openai-completions',
            models: [
              {
                id: 'accounts/fireworks/models/kimi-k2p5',
                name: 'Kimi K2.5',
                contextWindow: 131072,
                maxTokens: 32768,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: 'fireworks/accounts/fireworks/models/kimi-k2p5',
          },
        },
      },
    },
  },
};

export const EMPTY_REGISTRY: TenantRegistry = {
  tenants: [],
  nextCid: 3,
  nextSubnetIndex: 1,
  nextGatewayPort: DEFAULT_CONFIG.network.gatewayPortStart,
};
