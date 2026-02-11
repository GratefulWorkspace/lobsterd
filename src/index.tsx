#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import { runEvict } from "./commands/evict.js";
import { preflight } from "./commands/init.js";
import { runLogs } from "./commands/logs.js";
import { runMolt } from "./commands/molt.js";
import { runSnap } from "./commands/snap.js";
import { runSpawn } from "./commands/spawn.js";
import { runTank } from "./commands/tank.js";
import { runWatch } from "./commands/watch.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { loadConfig, loadRegistry } from "./config/loader.js";
import { PROVIDER_DEFAULTS, buildProviderConfig } from "./config/models.js";
import { InitFlow } from "./ui/InitFlow.js";
import { MoltResults } from "./ui/MoltProgress.js";
import { SpawnFlow } from "./ui/SpawnFlow.js";

const program = new Command();

program
  .name("lobsterd")
  .description("🦞 lobsterd — Firecracker MicroVM Tenant Orchestrator")
  .version("0.2.0");

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize host (install deps, check KVM, configure Caddy)")
  .action(async () => {
    const configResult = await loadConfig();
    const config = configResult.isOk() ? configResult.value : DEFAULT_CONFIG;

    const pre = await preflight(config);
    if (pre.isErr()) {
      console.error(`\n${pre.error.message}`);
      process.exit(1);
    }

    if (pre.value.missing.caddy && !pre.value.caddyPackageManager) {
      console.error(
        "\nCaddy not found and no supported package manager detected (apt-get, dnf, yum, pacman)",
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <InitFlow preflight={pre.value} config={config} />,
    );
    await waitUntilExit();
  });

// ── spawn ─────────────────────────────────────────────────────────────────────

program
  .command("spawn <name>")
  .description("Add a new tenant (Firecracker microVM)")
  .option("-k, --api-key <key>", "API key for the model provider")
  .option("--base-url <url>", "OpenAI-compatible base URL")
  .option("--model <id>", "Model identifier at the provider")
  .option("--model-name <name>", "Human-readable model display name")
  .option("--context-window <n>", "Max input tokens", Number.parseInt)
  .option("--max-tokens <n>", "Max output tokens per response", Number.parseInt)
  .action(
    async (
      name: string,
      opts: {
        apiKey?: string;
        baseUrl?: string;
        model?: string;
        modelName?: string;
        contextWindow?: number;
        maxTokens?: number;
      },
    ) => {
      // Non-interactive mode: --api-key provided
      if (opts.apiKey) {
        const override = buildProviderConfig({
          baseUrl: opts.baseUrl ?? PROVIDER_DEFAULTS.baseUrl,
          model: opts.model ?? PROVIDER_DEFAULTS.model,
          modelName: opts.modelName ?? PROVIDER_DEFAULTS.modelName,
          contextWindow: opts.contextWindow ?? PROVIDER_DEFAULTS.contextWindow,
          maxTokens: opts.maxTokens ?? PROVIDER_DEFAULTS.maxTokens,
          apiKey: opts.apiKey,
        });
        console.log(`Spawning tenant "${name}"...`);
        const result = await runSpawn(
          name,
          (p) => {
            console.log(`  [${p.step}] ${p.detail}`);
          },
          { openclawOverride: override },
        );

        if (result.isErr()) {
          console.error(`\n✗ ${result.error.message}`);
          process.exit(1);
        }

        const t = result.value;
        console.log(`\nTenant "${t.name}" spawned successfully.`);
        console.log(
          `  CID: ${t.cid}  IP: ${t.ipAddress}  Port: ${t.gatewayPort}  PID: ${t.vmPid}`,
        );
        return;
      }

      // Interactive mode: no --api-key
      const { waitUntilExit } = render(<SpawnFlow name={name} />);
      await waitUntilExit();
    },
  );

// ── evict ─────────────────────────────────────────────────────────────────────

program
  .command("evict <name>")
  .description("Remove a tenant (with confirmation)")
  .option("-y, --yes", "Skip confirmation")
  .action(async (name: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      process.stdout.write(
        `Remove tenant "${name}"? This destroys the VM and all data. [y/N] `,
      );
      const response = await new Promise<string>((resolve) => {
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", (data) => resolve(data.toString().trim()));
        process.stdin.resume();
      });
      if (response.toLowerCase() !== "y") {
        console.log("Aborted.");
        process.exit(0);
      }
    }

    console.log(`Evicting tenant "${name}"...`);
    const result = await runEvict(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    console.log(`\nTenant "${name}" evicted.`);
  });

// ── molt ──────────────────────────────────────────────────────────────────────

program
  .command("molt [name]")
  .description("Idempotent repair — one tenant or all")
  .action(async (name?: string) => {
    const target = name ? `tenant "${name}"` : "all tenants";
    console.log(`Molting ${target}...`);

    const result = await runMolt(name, (p) => {
      console.log(
        `  [${p.tenant}] ${p.phase}${p.detail ? `: ${p.detail}` : ""}`,
      );
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const results = result.value;
    const { unmount } = render(<MoltResults results={results} />);
    await new Promise((r) => setTimeout(r, 100));
    unmount();

    const allHealthy = results.every((r) => r.healthy);
    process.exit(allHealthy ? 0 : 1);
  });

// ── snap ──────────────────────────────────────────────────────────────────────

program
  .command("snap <name>")
  .description("Snapshot overlay file")
  .option("--prune", "Prune old snapshots beyond retention")
  .action(async (name: string, opts: { prune?: boolean }) => {
    const result = await runSnap(name, opts);

    if (result.isErr()) {
      console.error(`✗ ${result.error.message}`);
      process.exit(1);
    }

    console.log(`Snapshot created: ${result.value}`);
  });

// ── watch ─────────────────────────────────────────────────────────────────────

program
  .command("watch")
  .description("Start watchdog (TUI foreground, or --daemon)")
  .option("-d, --daemon", "Run as daemon (log to console)")
  .action(async (opts: { daemon?: boolean }) => {
    const code = await runWatch(opts);
    process.exit(code);
  });

// ── tank ──────────────────────────────────────────────────────────────────────

program
  .command("tank")
  .description("TUI dashboard showing all tenant health")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const code = await runTank({ json: opts.json });
    process.exit(code);
  });

// ── logs ──────────────────────────────────────────────────────────────────────

program
  .command("logs <name>")
  .description("Stream tenant logs")
  .option("-s, --service <service>", "Service to stream logs for")
  .action(async (name: string, opts: { service?: string }) => {
    const code = await runLogs(name, opts);
    process.exit(code);
  });

// ── token ─────────────────────────────────────────────────────────────────────

program
  .command("token <name>")
  .description("Print gateway token for a tenant")
  .action(async (name: string) => {
    const reg = await loadRegistry();
    if (reg.isErr()) {
      console.error(`Error: ${reg.error.message}`);
      process.exit(1);
    }
    const tenant = reg.value.tenants.find((t) => t.name === name);
    if (!tenant) {
      console.error(`Tenant "${name}" not found`);
      process.exit(1);
    }
    console.log(tenant.gatewayToken);
  });

program.parse();
