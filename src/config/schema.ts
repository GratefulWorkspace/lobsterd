import { z } from 'zod';

export const zfsConfigSchema = z.object({
  pool: z.string().min(1),
  parentDataset: z.string().min(1),
  defaultQuota: z.string().regex(/^\d+[KMGTP]$/i, 'Must be like 50G, 1T, etc.'),
  compression: z.enum(['lz4', 'zstd', 'gzip', 'off']),
  snapshotRetention: z.number().int().min(0),
});

export const tenantsConfigSchema = z.object({
  uidStart: z.number().int().min(1000),
  gatewayPortStart: z.number().int().min(1024).max(65535),
  homeBase: z.string().min(1),
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
  zfs: zfsConfigSchema,
  tenants: tenantsConfigSchema,
  watchdog: watchdogConfigSchema,
  openclaw: openclawConfigSchema,
});

export const tenantSchema = z.object({
  name: z.string().min(1).regex(/^[a-z][a-z0-9_-]*$/, 'Lowercase alphanumeric, hyphens, underscores'),
  uid: z.number().int().min(1000),
  gid: z.number().int().min(1000),
  gatewayPort: z.number().int().min(1024).max(65535),
  zfsDataset: z.string().min(1),
  homePath: z.string().min(1),
  createdAt: z.string().datetime(),
  status: z.enum(['active', 'suspended', 'removing']),
});

export const tenantRegistrySchema = z.object({
  tenants: z.array(tenantSchema),
  nextUid: z.number().int().min(1000),
  nextGatewayPort: z.number().int().min(1024).max(65535),
});
