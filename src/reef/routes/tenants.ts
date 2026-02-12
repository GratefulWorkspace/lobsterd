import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { runEvict } from "../../commands/evict.js";
import { runSpawn } from "../../commands/spawn.js";
import { buildTankEntries } from "../../commands/tank-data.js";
import { loadConfig, loadRegistry } from "../../config/loader.js";
import { buildProviderConfig, PROVIDER_DEFAULTS } from "../../config/models.js";
import { errorToStatus, stripSecrets } from "../errors.js";
import {
  ErrorResponse,
  SpawnRequestBody,
  TankEntrySchema,
  TenantNameParam,
  TenantResponse,
} from "../schemas.js";

// ── GET /tenants ────────────────────────────────────────────────────────────

const listTenantsRoute = createRoute({
  method: "get",
  path: "/tenants",
  tags: ["Tenants"],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.array(TankEntrySchema) },
      },
      description: "List of all tenants with health info",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

// ── POST /tenants ───────────────────────────────────────────────────────────

const spawnTenantRoute = createRoute({
  method: "post",
  path: "/tenants",
  tags: ["Tenants"],
  request: {
    body: {
      content: { "application/json": { schema: SpawnRequestBody } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: TenantResponse } },
      description: "Tenant spawned successfully",
    },
    409: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Tenant already exists",
    },
    422: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Validation error",
    },
    500: {
      content: { "application/json": { schema: ErrorResponse } },
      description: "Server error",
    },
  },
});

// ── DELETE /tenants/:name ───────────────────────────────────────────────────

const evictTenantRoute = createRoute({
  method: "delete",
  path: "/tenants/{name}",
  tags: ["Tenants"],
  request: {
    params: z.object({ name: TenantNameParam }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ message: z.string() }),
        },
      },
      description: "Tenant evicted",
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

// ── Registration ────────────────────────────────────────────────────────────

export function registerTenantRoutes(app: OpenAPIHono) {
  app.openapi(listTenantsRoute, async (c) => {
    const configResult = await loadConfig();
    if (configResult.isErr()) {
      return c.json(stripSecrets(configResult.error), 500);
    }
    const registryResult = await loadRegistry();
    if (registryResult.isErr()) {
      return c.json(stripSecrets(registryResult.error), 500);
    }

    const entries = await buildTankEntries(
      registryResult.value.tenants,
      configResult.value,
    );
    return c.json(entries, 200);
  });

  app.openapi(spawnTenantRoute, async (c) => {
    const body = c.req.valid("json");

    const options: { openclawOverride?: Record<string, unknown> } = {};
    if (body.apiKey) {
      options.openclawOverride = buildProviderConfig({
        baseUrl: body.baseUrl ?? PROVIDER_DEFAULTS.baseUrl,
        model: body.model ?? PROVIDER_DEFAULTS.model,
        modelName: body.modelName ?? PROVIDER_DEFAULTS.modelName,
        contextWindow: body.contextWindow ?? PROVIDER_DEFAULTS.contextWindow,
        maxTokens: body.maxTokens ?? PROVIDER_DEFAULTS.maxTokens,
        apiKey: body.apiKey,
      });
    }

    const result = await runSpawn(body.name, undefined, options);
    if (result.isErr()) {
      const status = errorToStatus(result.error) as 409 | 422 | 500;
      return c.json(stripSecrets(result.error), status);
    }

    const t = result.value;
    return c.json(
      {
        name: t.name,
        cid: t.cid,
        ipAddress: t.ipAddress,
        gatewayPort: t.gatewayPort,
        vmPid: t.vmPid,
        status: t.status,
        createdAt: t.createdAt,
      },
      201,
    );
  });

  app.openapi(evictTenantRoute, async (c) => {
    const { name } = c.req.valid("param");
    const result = await runEvict(name);
    if (result.isErr()) {
      const status = errorToStatus(result.error) as 404 | 500;
      return c.json(stripSecrets(result.error), status);
    }
    return c.json({ message: `Tenant "${name}" evicted` }, 200);
  });
}
