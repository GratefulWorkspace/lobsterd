import { ResultAsync } from "neverthrow";
import type { LobsterError, RateLimiter, TokenBucket } from "../types/index.js";

function toFcBucket(bucket: TokenBucket): Record<string, unknown> {
  return {
    size: bucket.size,
    one_time_burst: bucket.oneTimeBurst ?? 0,
    refill_time: bucket.refillTime,
  };
}

function toFcRateLimiter(limiter: RateLimiter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (limiter.bandwidth) {
    out.bandwidth = toFcBucket(limiter.bandwidth);
  }
  if (limiter.ops) {
    out.ops = toFcBucket(limiter.ops);
  }
  return out;
}

function fcApi(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): ResultAsync<unknown, LobsterError> {
  return ResultAsync.fromPromise(
    (async () => {
      const res = await fetch(`http://localhost${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        unix: socketPath,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Firecracker API ${method} ${path} failed (${res.status}): ${text}`,
        );
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    })(),
    (e) => ({
      code: "VM_BOOT_FAILED" as const,
      message: `Firecracker API error: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  );
}

export function configureVm(
  socketPath: string,
  config: { vcpuCount: number; memSizeMib: number },
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/machine-config", {
    vcpu_count: config.vcpuCount,
    mem_size_mib: config.memSizeMib,
  }).map(() => undefined);
}

export function setBootSource(
  socketPath: string,
  kernelImagePath: string,
  bootArgs: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/boot-source", {
    kernel_image_path: kernelImagePath,
    boot_args: bootArgs,
  }).map(() => undefined);
}

export function addDrive(
  socketPath: string,
  driveId: string,
  pathOnHost: string,
  isReadOnly: boolean,
  rateLimiter?: RateLimiter,
): ResultAsync<void, LobsterError> {
  const body: Record<string, unknown> = {
    drive_id: driveId,
    path_on_host: pathOnHost,
    is_root_device: driveId === "rootfs",
    is_read_only: isReadOnly,
  };
  if (rateLimiter) {
    body.rate_limiter = toFcRateLimiter(rateLimiter);
  }
  return fcApi(socketPath, "PUT", `/drives/${driveId}`, body).map(
    () => undefined,
  );
}

export function addVsock(
  socketPath: string,
  guestCid: number,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/vsock", {
    guest_cid: guestCid,
    uds_path: "vsock.socket",
  }).map(() => undefined);
}

export function addNetworkInterface(
  socketPath: string,
  ifaceId: string,
  hostDevName: string,
  rxRateLimiter?: RateLimiter,
  txRateLimiter?: RateLimiter,
): ResultAsync<void, LobsterError> {
  const body: Record<string, unknown> = {
    iface_id: ifaceId,
    host_dev_name: hostDevName,
  };
  if (rxRateLimiter) {
    body.rx_rate_limiter = toFcRateLimiter(rxRateLimiter);
  }
  if (txRateLimiter) {
    body.tx_rate_limiter = toFcRateLimiter(txRateLimiter);
  }
  return fcApi(socketPath, "PUT", `/network-interfaces/${ifaceId}`, body).map(
    () => undefined,
  );
}

export function startInstance(
  socketPath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/actions", {
    action_type: "InstanceStart",
  }).map(() => undefined);
}

export function sendCtrlAltDel(
  socketPath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/actions", {
    action_type: "SendCtrlAltDel",
  }).map(() => undefined);
}

export function pauseVm(
  socketPath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PATCH", "/vm", {
    state: "Paused",
  }).map(() => undefined);
}

export function resumeVm(
  socketPath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PATCH", "/vm", {
    state: "Resumed",
  }).map(() => undefined);
}

export function createSnapshot(
  socketPath: string,
  snapshotPath: string,
  memFilePath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/snapshot/create", {
    snapshot_type: "Full",
    snapshot_path: snapshotPath,
    mem_file_path: memFilePath,
  })
    .map(() => undefined)
    .mapErr((e) => ({
      ...e,
      code: "SNAPSHOT_FAILED" as const,
    }));
}

export function loadSnapshot(
  socketPath: string,
  snapshotPath: string,
  memFilePath: string,
): ResultAsync<void, LobsterError> {
  return fcApi(socketPath, "PUT", "/snapshot/load", {
    snapshot_path: snapshotPath,
    mem_file_path: memFilePath,
    resume_vm: true,
  })
    .map(() => undefined)
    .mapErr((e) => ({
      ...e,
      code: "SNAPSHOT_FAILED" as const,
    }));
}
