import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { runMolt } from "../../commands/molt.js";
import { runSnap } from "../../commands/snap.js";
import { errorToStatus, stripSecrets } from "../errors.js";
import {
  ErrorResponse,
  MoltResultSchema,
  SnapResultSchema,
  TenantNameParam,
} from "../schemas.js";

// ── POST /tenants/:name/molt ────────────────────────────────────────────────

const moltRoute = createRoute({
  method: "post",
  path: "/tenants/{name}/molt",
  tags: ["Tenant Operations"],
  request: {
    params: z.object({ name: TenantNameParam }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: MoltResultSchema } },
      description: "Molt result for the tenant",
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

// ── POST /tenants/:name/snap ────────────────────────────────────────────────

const snapRoute = createRoute({
  method: "post",
  path: "/tenants/{name}/snap",
  tags: ["Tenant Operations"],
  request: {
    params: z.object({ name: TenantNameParam }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: SnapResultSchema } },
      description: "Snapshot metadata",
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

export function registerTenantOpsRoutes(app: OpenAPIHono) {
  app.openapi(moltRoute, async (c) => {
    const { name } = c.req.valid("param");
    const result = await runMolt(name);
    if (result.isErr()) {
      const status = errorToStatus(result.error) as 404 | 500;
      return c.json(stripSecrets(result.error), status);
    }

    const entry = result.value[0];
    if (!entry) {
      return c.json(
        { code: "TENANT_NOT_FOUND", message: `No results for "${name}"` },
        404,
      );
    }
    return c.json(entry, 200);
  });

  app.openapi(snapRoute, async (c) => {
    const { name } = c.req.valid("param");
    const result = await runSnap(name, { json: true });
    if (result.isErr()) {
      const status = errorToStatus(result.error) as 404 | 500;
      return c.json(stripSecrets(result.error), status);
    }
    return c.json(result.value, 200);
  });
}
