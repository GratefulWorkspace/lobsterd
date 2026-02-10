// ── Tenant ──────────────────────────────────────────────────────────────────

export type TenantStatus = 'active' | 'suspended' | 'removing';

export interface Tenant {
  name: string;
  uid: number;
  gid: number;
  gatewayPort: number;
  zfsDataset: string;
  homePath: string;
  createdAt: string;
  status: TenantStatus;
  gatewayToken?: string;
}

// ── Health ───────────────────────────────────────────────────────────────────

export type HealthStatus = 'ok' | 'degraded' | 'failed';

export interface HealthCheckResult {
  check: string;
  status: HealthStatus;
  message: string;
}

export interface RepairResult {
  repair: string;
  fixed: boolean;
  actions: string[];
}

// ── Watchdog ─────────────────────────────────────────────────────────────────

export type WatchState = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'RECOVERING';

export interface TenantWatchState {
  state: WatchState;
  lastCheck: string | null;
  lastResults: HealthCheckResult[];
  repairAttempts: number;
  lastRepairAt: string | null;
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface ZfsConfig {
  pool: string;
  parentDataset: string;
  defaultQuota: string;
  compression: string;
  snapshotRetention: number;
}

export interface TenantsConfig {
  uidStart: number;
  gatewayPortStart: number;
  homeBase: string;
}

export interface WatchdogConfig {
  intervalMs: number;
  maxRepairAttempts: number;
  repairCooldownMs: number;
}

export interface OpenclawConfig {
  installPath: string;
  defaultConfig: Record<string, unknown>;
}

export interface LobsterdConfig {
  zfs: ZfsConfig;
  tenants: TenantsConfig;
  watchdog: WatchdogConfig;
  openclaw: OpenclawConfig;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface TenantRegistry {
  tenants: Tenant[];
  nextUid: number;
  nextGatewayPort: number;
}

// ── Exec ─────────────────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ErrorCode =
  | 'EXEC_FAILED'
  | 'EXEC_TIMEOUT'
  | 'NOT_ROOT'
  | 'NOT_LINUX'
  | 'ZFS_NOT_AVAILABLE'
  | 'ZFS_DATASET_EXISTS'
  | 'ZFS_DATASET_NOT_FOUND'
  | 'USER_EXISTS'
  | 'USER_NOT_FOUND'
  | 'DOCKER_NOT_INSTALLED'
  | 'DOCKER_UNRESPONSIVE'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'TENANT_EXISTS'
  | 'TENANT_NOT_FOUND'
  | 'GATEWAY_UNRESPONSIVE'
  | 'SERVICE_FAILED'
  | 'PERMISSION_DENIED'
  | 'UNKNOWN';

export interface LobsterError {
  code: ErrorCode;
  message: string;
  cause?: unknown;
}

// ── Watchdog Events ──────────────────────────────────────────────────────────

export interface WatchdogEvents {
  'check-complete': { tenant: string; results: HealthCheckResult[] };
  'repair-start': { tenant: string; checks: HealthCheckResult[] };
  'repair-complete': { tenant: string; results: RepairResult[] };
  'state-change': { tenant: string; from: WatchState; to: WatchState };
  'tick-complete': { timestamp: string; states: Record<string, TenantWatchState> };
}
