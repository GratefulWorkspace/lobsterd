import { statfsSync } from "node:fs";
import { okAsync, type ResultAsync } from "neverthrow";
import type { JailerConfig, LobsterError } from "../types/index.js";
import { exec } from "./exec.js";

/** Detect whether the host uses cgroup v1 or v2. */
function isCgroupV2(): boolean {
  try {
    // cgroup2fs has magic number 0x63677270, tmpfs (cgroup v1) has 0x01021994
    const stat = statfsSync("/sys/fs/cgroup");
    return stat.type === 0x63677270;
  } catch {
    return false;
  }
}

export function getChrootRoot(chrootBaseDir: string, vmId: string): string {
  return `${chrootBaseDir}/firecracker/${vmId}/root`;
}

export function getApiSocketPath(chrootBaseDir: string, vmId: string): string {
  return `${getChrootRoot(chrootBaseDir, vmId)}/api.socket`;
}

/** Hard-link drive and kernel files into an existing jailer chroot. */
export function linkChrootFiles(
  chrootBaseDir: string,
  vmId: string,
  kernelPath: string,
  rootfsPath: string,
  overlayPath: string,
  uid: number,
): ResultAsync<void, LobsterError> {
  const root = getChrootRoot(chrootBaseDir, vmId);
  return exec(["ln", "-f", kernelPath, `${root}/vmlinux`])
    .andThen(() => exec(["ln", "-f", rootfsPath, `${root}/rootfs.ext4`]))
    .andThen(() => exec(["ln", "-f", overlayPath, `${root}/overlay.ext4`]))
    .andThen(() => exec(["chown", `${uid}:${uid}`, `${root}/overlay.ext4`]))
    .map(() => undefined)
    .mapErr((e) => ({
      ...e,
      code: "JAILER_SETUP_FAILED" as const,
      message: `Failed to set up jailer chroot files: ${e.message}`,
    }));
}

/** Remove the entire jailer chroot directory for a VM. */
export function cleanupChroot(
  chrootBaseDir: string,
  vmId: string,
): ResultAsync<void, LobsterError> {
  const vmDir = `${chrootBaseDir}/firecracker/${vmId}`;
  return exec(["rm", "-rf", vmDir])
    .map(() => undefined)
    .orElse(() => okAsync(undefined));
}

/** Build the jailer command-line arguments. */
export function buildJailerArgs(
  jailerConfig: JailerConfig,
  firecrackerBinaryPath: string,
  vmId: string,
  uid: number,
  cgroups?: { memLimitBytes: number; cpuQuotaUs: number; cpuPeriodUs: number },
): string[] {
  const args = [
    jailerConfig.binaryPath,
    "--id",
    vmId,
    "--exec-file",
    firecrackerBinaryPath,
    "--uid",
    String(uid),
    "--gid",
    String(uid),
    "--chroot-base-dir",
    jailerConfig.chrootBaseDir,
  ];
  if (cgroups) {
    if (isCgroupV2()) {
      args.push("--cgroup-version", "2");
      args.push("--cgroup", `memory.max=${cgroups.memLimitBytes}`);
      args.push(
        "--cgroup",
        `cpu.max=${cgroups.cpuQuotaUs} ${cgroups.cpuPeriodUs}`,
      );
    } else {
      args.push("--cgroup", `memory.limit_in_bytes=${cgroups.memLimitBytes}`);
      args.push("--cgroup", `cpu.cfs_quota_us=${cgroups.cpuQuotaUs}`);
      args.push("--cgroup", `cpu.cfs_period_us=${cgroups.cpuPeriodUs}`);
    }
  }
  args.push("--", "--api-sock", "api.socket");
  return args;
}
