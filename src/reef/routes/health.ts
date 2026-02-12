import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute } from "@hono/zod-openapi";
import { loadRegistry } from "../../config/loader.js";
import { HealthResponse } from "../schemas.js";

const startedAt = Date.now();

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  responses: {
    200: {
      content: { "application/json": { schema: HealthResponse } },
      description: "Server health status",
    },
  },
});

export function registerHealthRoutes(app: OpenAPIHono) {
  app.openapi(healthRoute, async (c) => {
    const reg = await loadRegistry();
    const tenantCount = reg.isOk() ? reg.value.tenants.length : 0;

    return c.json(
      {
        status: "ok" as const,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        tenantCount,
      },
      200,
    );
  });
}
