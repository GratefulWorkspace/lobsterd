import type { ErrorCode, LobsterError } from "../types/index.js";

const STATUS_MAP: Record<ErrorCode, number> = {
  EXEC_FAILED: 500,
  EXEC_TIMEOUT: 504,
  NOT_ROOT: 403,
  NOT_LINUX: 500,
  KVM_NOT_AVAILABLE: 500,
  FIRECRACKER_NOT_FOUND: 500,
  JAILER_NOT_FOUND: 500,
  JAILER_SETUP_FAILED: 500,
  VM_BOOT_FAILED: 500,
  VSOCK_CONNECT_FAILED: 502,
  TAP_CREATE_FAILED: 500,
  CADDY_API_ERROR: 502,
  OVERLAY_CREATE_FAILED: 500,
  CONFIG_NOT_FOUND: 500,
  CONFIG_INVALID: 500,
  TENANT_EXISTS: 409,
  TENANT_NOT_FOUND: 404,
  PERMISSION_DENIED: 403,
  VALIDATION_FAILED: 422,
  LOCK_FAILED: 503,
  BUOY_ALREADY_RUNNING: 500,
  SNAPSHOT_FAILED: 500,
  SUSPEND_FAILED: 500,
  RESUME_FAILED: 500,
  UNINIT_FAILED: 500,
  UNKNOWN: 500,
};

export function errorToStatus(error: LobsterError): number {
  return STATUS_MAP[error.code] ?? 500;
}

export function stripSecrets(error: LobsterError): {
  code: ErrorCode;
  message: string;
} {
  return { code: error.code, message: error.message };
}
