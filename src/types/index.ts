// ── Tenant ──────────────────────────────────────────────────────────────────

export type TenantStatus = 'active' | 'suspended' | 'removing';

export interface Tenant {
  name: string;
  vmId: string;
  cid: number;
  ipAddress: string;
  hostIp: string;
  tapDev: string;
  gatewayPort: number;
  overlayPath: string;
  socketPath: string;
  vmPid: number | null;
  createdAt: string;
  status: TenantStatus;
  gatewayToken: string;
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

export interface FirecrackerConfig {
  binaryPath: string;
  kernelPath: string;
  rootfsPath: string;
  defaultVcpuCount: number;
  defaultMemSizeMb: number;
}

export interface NetworkConfig {
  bridgeName: string;
  subnetBase: string;
  subnetMask: number;
  gatewayPortStart: number;
}

export interface CaddyConfig {
  adminApi: string;
  domain: string;
}

export interface VsockConfig {
  agentPort: number;
  connectTimeoutMs: number;
  healthPort: number;
}

export interface OverlayConfig {
  baseDir: string;
  defaultSizeMb: number;
  snapshotRetention: number;
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
  firecracker: FirecrackerConfig;
  network: NetworkConfig;
  caddy: CaddyConfig;
  vsock: VsockConfig;
  overlay: OverlayConfig;
  watchdog: WatchdogConfig;
  openclaw: OpenclawConfig;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface TenantRegistry {
  tenants: Tenant[];
  nextCid: number;
  nextSubnetIndex: number;
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
  | 'KVM_NOT_AVAILABLE'
  | 'FIRECRACKER_NOT_FOUND'
  | 'VM_BOOT_FAILED'
  | 'VSOCK_CONNECT_FAILED'
  | 'TAP_CREATE_FAILED'
  | 'CADDY_API_ERROR'
  | 'OVERLAY_CREATE_FAILED'
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'TENANT_EXISTS'
  | 'TENANT_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'VALIDATION_FAILED'
  | 'LOCK_FAILED'
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
