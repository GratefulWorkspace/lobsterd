import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { loadConfig, loadRegistry } from "../../config/loader.js";
import { fetchLogs } from "../../system/logs.js";
import {
  ErrorResponse,
  LogsResponse,
  TenantNameParam,
  TokenResponse,
} from "../schemas.js";

// ── GET /tenants/:name/token ────────────────────────────────────────────────

const tokenRoute = createRoute({
  method: "get",
  path: "/tenants/{name}/token",
  tags: ["Tenant Info"],
  request: {
    params: z.object({ name: TenantNameParam }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: TokenResponse } },
      description: "Gateway token for the tenant",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Tenant not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

// ── GET /tenants/:name/logs ─────────────────────────────────────────────────

const logsRoute = createRoute({
  method: "get",
  path: "/tenants/{name}/logs",
  tags: ["Tenant Info"],
  request: {
    params: z.object({ name: TenantNameParam }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: LogsResponse } },
      description: "Tenant logs",
    },
    404: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Tenant not found",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Failed to fetch logs",
    },
  },
});

// ── Registration ────────────────────────────────────────────────────────────

export function registerTenantInfoRoutes(app: OpenAPIHono) {
  app.openapi(tokenRoute, async (c) => {
    const { name } = c.req.valid("param");
    const reg = await loadRegistry();
    if (reg.isErr()) {
      return c.json({ code: "UNKNOWN", message: reg.error.message }, 500);
    }
    const tenant = reg.value.tenants.find((t) => t.name === name);
    if (!tenant) {
      return c.json(
        { code: "TENANT_NOT_FOUND", message: `Tenant "${name}" not found` },
        404,
      );
    }
    return c.json({ token: tenant.gatewayToken }, 200);
  });

  app.openapi(logsRoute, async (c) => {
    const { name } = c.req.valid("param");
    const configResult = await loadConfig();
    if (configResult.isErr()) {
      return c.json(
        { code: "UNKNOWN", message: configResult.error.message },
        500,
      );
    }
    const reg = await loadRegistry();
    if (reg.isErr()) {
      return c.json({ code: "UNKNOWN", message: reg.error.message }, 500);
    }
    const tenant = reg.value.tenants.find((t) => t.name === name);
    if (!tenant) {
      return c.json(
        { code: "TENANT_NOT_FOUND", message: `Tenant "${name}" not found` },
        404,
      );
    }

    try {
      const logs = await fetchLogs(
        tenant.ipAddress,
        configResult.value.vsock.agentPort,
        tenant.agentToken,
      );
      return c.json({ logs }, 200);
    } catch (e) {
      return c.json(
        {
          code: "VSOCK_CONNECT_FAILED",
          message: `Failed to fetch logs: ${e instanceof Error ? e.message : String(e)}`,
        },
        500,
      );
    }
  });
}
