import { z } from "@hono/zod-openapi";
import { TENANT_NAME_REGEX } from "../config/schema.js";

// ── Shared ──────────────────────────────────────────────────────────────────

export const ErrorResponse = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .openapi("ErrorResponse");

export const TenantNameParam = z
  .string()
  .regex(TENANT_NAME_REGEX)
  .openapi({ param: { name: "name", in: "path" }, example: "my-tenant" });

// ── Health ──────────────────────────────────────────────────────────────────

export const HealthResponse = z
  .object({
    status: z.enum(["ok", "degraded"]),
    uptime: z.number(),
    tenantCount: z.number(),
  })
  .openapi("HealthResponse");

// ── Tenants ─────────────────────────────────────────────────────────────────

export const TankEntrySchema = z
  .object({
    name: z.string(),
    cid: z.number(),
    ip: z.string(),
    port: z.number(),
    vmPid: z.string(),
    status: z.string(),
    memoryMb: z.number().optional(),
    state: z.string(),
  })
  .openapi("TankEntry");

export const SpawnRequestBody = z
  .object({
    name: z.string().regex(TENANT_NAME_REGEX),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    modelName: z.string().optional(),
    contextWindow: z.number().int().optional(),
    maxTokens: z.number().int().optional(),
  })
  .openapi("SpawnRequest");

export const TenantResponse = z
  .object({
    name: z.string(),
    cid: z.number(),
    ipAddress: z.string(),
    gatewayPort: z.number(),
    vmPid: z.number().nullable(),
    status: z.string(),
    createdAt: z.string(),
  })
  .openapi("TenantResponse");

// ── Tenant Operations ───────────────────────────────────────────────────────

export const MoltResultSchema = z
  .object({
    tenant: z.string(),
    healthy: z.boolean(),
    initialChecks: z.array(
      z.object({
        check: z.string(),
        status: z.string(),
        message: z.string(),
      }),
    ),
    repairs: z.array(
      z.object({
        repair: z.string(),
        fixed: z.boolean(),
        actions: z.array(z.string()),
      }),
    ),
    finalChecks: z.array(
      z.object({
        check: z.string(),
        status: z.string(),
        message: z.string(),
      }),
    ),
  })
  .openapi("MoltResult");

export const SnapResultSchema = z
  .object({
    path: z.string(),
    tenant: z.string(),
    timestamp: z.string(),
  })
  .openapi("SnapResult");

// ── Tenant Info ─────────────────────────────────────────────────────────────

export const TokenResponse = z
  .object({
    token: z.string(),
  })
  .openapi("TokenResponse");

export const LogsResponse = z
  .object({
    logs: z.string(),
  })
  .openapi("LogsResponse");
