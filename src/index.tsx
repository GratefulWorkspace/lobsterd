#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import { runEvict } from "./commands/evict.js";
import { preflight } from "./commands/init.js";
import { formatTable, runList } from "./commands/list.js";
import { runLogs } from "./commands/logs.js";
import { runMolt } from "./commands/molt.js";
import { runSnap } from "./commands/snap.js";
import { runSpawn } from "./commands/spawn.js";
import { runTank } from "./commands/tank.js";
import { runWatch } from "./commands/watch.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { loadConfig } from "./config/loader.js";
import { InitFlow } from "./ui/InitFlow.js";
import { MoltResults } from "./ui/MoltProgress.js";

const program = new Command();

program
  .name("lobsterd")
  .description("lobsterd — Firecracker MicroVM Tenant Orchestrator")
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
  .action(async (name: string) => {
    console.log(`Spawning tenant "${name}"...`);
    const result = await runSpawn(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const t = result.value;
    console.log(`\nTenant "${t.name}" spawned successfully.`);
    console.log(
      `  CID: ${t.cid}  IP: ${t.ipAddress}  Port: ${t.gatewayPort}  PID: ${t.vmPid}`,
    );
  });

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

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List tenants with status")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const result = await runList(opts);

    if (result.isErr()) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result.value, null, 2));
    } else {
      console.log(formatTable(result.value));
    }
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
  .action(async () => {
    const code = await runTank();
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

program.parse();
