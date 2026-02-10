import { z } from 'zod';

export const TENANT_NAME_REGEX = /^[a-z][a-z0-9_-]*$/;

export const firecrackerConfigSchema = z.object({
  binaryPath: z.string().min(1),
  kernelPath: z.string().min(1),
  rootfsPath: z.string().min(1),
  defaultVcpuCount: z.number().int().min(1).max(32),
  defaultMemSizeMb: z.number().int().min(128),
});

export const networkConfigSchema = z.object({
  bridgeName: z.string().min(1),
  subnetBase: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'Must be a valid IPv4 address'),
  subnetMask: z.number().int().min(8).max(30),
  gatewayPortStart: z.number().int().min(1024).max(65535),
});

export const caddyConfigSchema = z.object({
  adminApi: z.string().url(),
  domain: z.string().min(1),
});

export const vsockConfigSchema = z.object({
  agentPort: z.number().int().min(1).max(65535),
  connectTimeoutMs: z.number().int().min(1000),
  healthPort: z.number().int().min(1).max(65535),
});

export const overlayConfigSchema = z.object({
  baseDir: z.string().min(1),
  defaultSizeMb: z.number().int().min(256),
  snapshotRetention: z.number().int().min(0),
});

export const watchdogConfigSchema = z.object({
  intervalMs: z.number().int().min(1000),
  maxRepairAttempts: z.number().int().min(1),
  repairCooldownMs: z.number().int().min(0),
});

export const openclawConfigSchema = z.object({
  installPath: z.string().min(1),
  defaultConfig: z.record(z.unknown()),
});

export const lobsterdConfigSchema = z.object({
  firecracker: firecrackerConfigSchema,
  network: networkConfigSchema,
  caddy: caddyConfigSchema,
  vsock: vsockConfigSchema,
  overlay: overlayConfigSchema,
  watchdog: watchdogConfigSchema,
  openclaw: openclawConfigSchema,
});

export const tenantSchema = z.object({
  name: z.string().min(1).regex(TENANT_NAME_REGEX, 'Lowercase alphanumeric, hyphens, underscores'),
  vmId: z.string().min(1),
  cid: z.number().int().min(3),
  ipAddress: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'Must be a valid IPv4 address'),
  hostIp: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/, 'Must be a valid IPv4 address'),
  tapDev: z.string().min(1),
  gatewayPort: z.number().int().min(1024).max(65535),
  overlayPath: z.string().min(1),
  socketPath: z.string().min(1),
  vmPid: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  status: z.enum(['active', 'suspended', 'removing']),
  gatewayToken: z.string().min(1),
});

export const tenantRegistrySchema = z.object({
  tenants: z.array(tenantSchema),
  nextCid: z.number().int().min(3),
  nextSubnetIndex: z.number().int().min(1),
  nextGatewayPort: z.number().int().min(1024).max(65535),
});
