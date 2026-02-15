// ── Tenant ──────────────────────────────────────────────────────────────────

export type TenantStatus = "active" | "suspended" | "removing";

export interface CronSchedule {
  kind: "cron" | "every" | "at";
  expr?: string;
  tz?: string;
  everyMs?: number;
  anchorMs?: number;
  at?: string;
}

export interface CronScheduleInfo {
  id: string;
  name: string;
  nextRunAtMs: number;
  schedule?: CronSchedule | null;
}

export interface SuspendInfo {
  suspendedAt: string;
  snapshotDir: string;
  cronSchedules: CronScheduleInfo[];
  nextWakeAtMs: number | null;
  lastRxBytes: number;
}

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
  jailUid: number;
  agentToken: string;
  suspendInfo: SuspendInfo | null;
}

// ── Health ───────────────────────────────────────────────────────────────────

export type HealthStatus = "ok" | "degraded" | "failed";

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

export type WatchState =
  | "UNKNOWN"
  | "HEALTHY"
  | "DEGRADED"
  | "FAILED"
  | "RECOVERING"
  | "SUSPENDED";

export interface TenantWatchState {
  state: WatchState;
  lastCheck: string | null;
  lastResults: HealthCheckResult[];
  repairAttempts: number;
  lastRepairAt: string | null;
}

// ── Config ───────────────────────────────────────────────────────────────────

// ── Rate Limiting ───────────────────────────────────────────────────────────

export interface TokenBucket {
  size: number;
  oneTimeBurst?: number;
  refillTime: number;
}

export interface RateLimiter {
  bandwidth?: TokenBucket;
  ops?: TokenBucket;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface JailerConfig {
  binaryPath: string;
  chrootBaseDir: string;
  uidStart: number;
}

export interface FirecrackerConfig {
  binaryPath: string;
  kernelPath: string;
  rootfsPath: string;
  defaultVcpuCount: number;
  defaultMemSizeMb: number;
  networkRxRateLimit?: RateLimiter;
  networkTxRateLimit?: RateLimiter;
  diskRateLimit?: RateLimiter;
}

export interface NetworkConfig {
  bridgeName: string;
  subnetBase: string;
  subnetMask: number;
  gatewayPortStart: number;
}

export interface CaddyTlsConfig {
  certPath: string;
  keyPath: string;
}

export interface CaddyConfig {
  adminApi: string;
  domain: string;
  tls?: CaddyTlsConfig;
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
  idleThresholdMs: number;
  cronWakeAheadMs: number;
  trafficPollMs: number;
}

export interface OpenclawDefaultConfig {
  gateway?: {
    auth?: {
      mode?: string;
      token?: string;
      [key: string]: unknown;
    };
    controlUi?: {
      allowedOrigins?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenclawConfig {
  installPath: string;
  defaultConfig: OpenclawDefaultConfig;
}

export interface BuoyConfig {
  port: number;
  host: string;
  apiToken: string;
  agentLockdown: boolean;
}

export interface LobsterdConfig {
  jailer: JailerConfig;
  firecracker: FirecrackerConfig;
  network: NetworkConfig;
  caddy: CaddyConfig;
  vsock: VsockConfig;
  overlay: OverlayConfig;
  watchdog: WatchdogConfig;
  openclaw: OpenclawConfig;
  buoy?: BuoyConfig;
}

// ── Guest Stats ─────────────────────────────────────────────────────────────

export interface GuestStats {
  gatewayPid: number | null;
  memoryKb: number;
  activeConnections: number;
}

// ── Registry ─────────────────────────────────────────────────────────────────

export interface TenantRegistry {
  tenants: Tenant[];
  nextCid: number;
  nextSubnetIndex: number;
  nextGatewayPort: number;
  nextJailUid: number;
}

// ── Exec ─────────────────────────────────────────────────────────────────────

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ErrorCode =
  | "EXEC_FAILED"
  | "EXEC_TIMEOUT"
  | "NOT_ROOT"
  | "NOT_LINUX"
  | "KVM_NOT_AVAILABLE"
  | "FIRECRACKER_NOT_FOUND"
  | "JAILER_NOT_FOUND"
  | "JAILER_SETUP_FAILED"
  | "VM_BOOT_FAILED"
  | "VSOCK_CONNECT_FAILED"
  | "TAP_CREATE_FAILED"
  | "CADDY_API_ERROR"
  | "OVERLAY_CREATE_FAILED"
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "TENANT_EXISTS"
  | "TENANT_NOT_FOUND"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "LOCK_FAILED"
  | "BUOY_ALREADY_RUNNING"
  | "SNAPSHOT_FAILED"
  | "SUSPEND_FAILED"
  | "RESUME_FAILED"
  | "UNINIT_FAILED"
  | "UNKNOWN";

export interface LobsterError {
  code: ErrorCode;
  message: string;
  cause?: unknown;
}

// ── Watchdog Events ──────────────────────────────────────────────────────────

export interface WatchdogEvents {
  "check-complete": { tenant: string; results: HealthCheckResult[] };
  "repair-start": { tenant: string; checks: HealthCheckResult[] };
  "repair-complete": { tenant: string; results: RepairResult[] };
  "state-change": { tenant: string; from: WatchState; to: WatchState };
  "tick-complete": {
    timestamp: string;
    states: Record<string, TenantWatchState>;
  };
  "suspend-start": { tenant: string };
  "suspend-complete": { tenant: string; nextWakeAtMs: number | null };
  "suspend-failed": { tenant: string; error: string };
  "resume-start": { tenant: string; trigger: "traffic" | "cron" | "manual" };
  "resume-complete": { tenant: string; vmPid: number | null };
  "resume-failed": { tenant: string; error: string };
}
