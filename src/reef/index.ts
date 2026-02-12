import { OpenAPIHono } from "@hono/zod-openapi";
import { DEFAULT_BUOY_CONFIG } from "../config/defaults.js";
import { loadConfig, saveConfig } from "../config/loader.js";
import type { BuoyConfig } from "../types/index.js";
import { bearerAuth } from "./auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTenantInfoRoutes } from "./routes/tenant-info.js";
import { registerTenantOpsRoutes } from "./routes/tenant-ops.js";
import { registerTenantRoutes } from "./routes/tenants.js";

export async function startBuoy(opts: {
  port?: number;
  host?: string;
}): Promise<void> {
  const configResult = await loadConfig();
  if (configResult.isErr()) {
    console.error(`Failed to load config: ${configResult.error.message}`);
    process.exit(1);
  }

  let config = configResult.value;
  const buoy: BuoyConfig = config.buoy ?? { ...DEFAULT_BUOY_CONFIG };

  // Auto-generate API token if not set
  if (!buoy.apiToken) {
    buoy.apiToken = crypto.randomUUID();
    config = { ...config, buoy };
    const saveResult = await saveConfig(config);
    if (saveResult.isErr()) {
      console.error(`Failed to save config: ${saveResult.error.message}`);
      process.exit(1);
    }
  }

  // CLI overrides
  const port = opts.port ?? buoy.port;
  const host = opts.host ?? buoy.host;

  const app = new OpenAPIHono();

  // Auth middleware
  app.use("*", bearerAuth(buoy.apiToken));

  // Register routes
  registerHealthRoutes(app);
  registerTenantRoutes(app);
  registerTenantOpsRoutes(app);
  registerTenantInfoRoutes(app);

  // OpenAPI spec
  app.doc("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "lobsterd buoy API",
      version: "0.2.0",
      description:
        "REST API for the lobsterd Firecracker MicroVM Tenant Orchestrator",
    },
  });

  console.log(`\nlobsterd buoy starting...`);
  console.log(`  URL:   http://${host}:${port}`);
  console.log(`  Token: ${buoy.apiToken}`);
  console.log(`  Spec:  http://${host}:${port}/openapi.json`);
  console.log(`  Lockdown: ${buoy.agentLockdown ? "enabled" : "disabled"}\n`);

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: app.fetch,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down buoy...");
    server.stop(true);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
