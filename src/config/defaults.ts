import type { LobsterdConfig, TenantRegistry } from '../types/index.js';

export const CONFIG_DIR = '/etc/lobsterd';
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
export const REGISTRY_PATH = `${CONFIG_DIR}/registry.json`;

export const DEFAULT_CONFIG: LobsterdConfig = {
  zfs: {
    pool: 'tank',
    parentDataset: 'tank/tenants',
    defaultQuota: '50G',
    compression: 'lz4',
    snapshotRetention: 7,
  },
  tenants: {
    uidStart: 10000,
    gatewayPortStart: 9000,
    homeBase: '/home',
  },
  watchdog: {
    intervalMs: 30_000,
    maxRepairAttempts: 3,
    repairCooldownMs: 60_000,
  },
  openclaw: {
    installPath: '/opt/openclaw',
    defaultConfig: {
      models: {
        providers: {
          fireworks: {
            baseUrl: 'https://api.fireworks.ai/inference/v1',
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
    apiKeys: {
      fireworks: 'fw_SM5UK6FtmAhA15UYscdTXk',
    },
  },
};

export const EMPTY_REGISTRY: TenantRegistry = {
  tenants: [],
  nextUid: DEFAULT_CONFIG.tenants.uidStart,
  nextGatewayPort: DEFAULT_CONFIG.tenants.gatewayPortStart,
};
