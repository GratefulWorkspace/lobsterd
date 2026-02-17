#!/usr/bin/env bun
import { Command } from "commander";
import { render } from "ink";
import { runEvict } from "./commands/evict.js";
import { runExec } from "./commands/exec.js";
import { preflight, runInit } from "./commands/init.js";
import { runLogs } from "./commands/logs.js";
import { runMolt } from "./commands/molt.js";
import { runResume } from "./commands/resume.js";
import { runSnap } from "./commands/snap.js";
import { runSpawn } from "./commands/spawn.js";
import { runSuspend } from "./commands/suspend.js";
import { runTank } from "./commands/tank.js";
import { runUninit } from "./commands/uninit.js";
import { runWatch } from "./commands/watch.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { loadConfig, loadRegistry } from "./config/loader.js";
import { startBuoy } from "./reef/index.js";
import { InitFlow } from "./ui/InitFlow.js";
import { MoltResults } from "./ui/MoltProgress.js";

const program = new Command();

program
  .name("lobsterd")
  .description("🦞 lobsterd — Firecracker MicroVM Tenant Orchestrator")
  .version("0.2.0")
  .enablePositionalOptions();

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize host (install deps, check KVM, configure Caddy)")
  .option("-d, --domain <domain>", "Domain for tenant routes")
  .option("-y, --yes", "Skip confirmation and auto-install missing deps")
  .action(async (opts: { domain?: string; yes?: boolean }) => {
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

    // Non-interactive mode: --yes provided
    if (opts.yes) {
      console.log("Initializing host...");
      const result = await runInit(config, {
        domain: opts.domain,
        install: { ...pre.value.missing },
      });

      if (result.isErr()) {
        console.error(`\n✗ ${result.error.message}`);
        process.exit(1);
      }

      console.log("\nHost initialized successfully.");
      return;
    }

    // Interactive mode
    const { waitUntilExit } = render(
      <InitFlow preflight={pre.value} config={config} />,
    );
    await waitUntilExit();
  });

// ── uninit ────────────────────────────────────────────────────────────────────

program
  .command("uninit")
  .description("Remove all lobsterd state (config, data, iptables chains)")
  .option("-y, --yes", "Skip confirmation")
  .action(async (opts: { yes?: boolean }) => {
    if (!opts.yes) {
      process.stdout.write(
        "Remove all lobsterd state? This deletes config and data directories. [y/N] ",
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

    console.log("Uninitializing lobsterd...");
    const result = await runUninit((p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    console.log("\nlobsterd uninitialized. Binaries were NOT removed.");
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

// ── exec ─────────────────────────────────────────────────────────────────────

program
  .command("exec <name> [command...]")
  .description("Run a command inside a tenant VM via SSH")
  .passThroughOptions()
  .action(async (name: string, command: string[]) => {
    const result = await runExec(name, command);

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    process.exit(result.value);
  });

// ── configure ────────────────────────────────────────────────────────────────

program
  .command("configure <name>")
  .description("Open the OpenClaw configuration TUI inside a tenant VM")
  .action(async (name: string) => {
    const result = await runExec(name, ["openclaw", "configure"]);

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    process.exit(result.value);
  });

// ── devices ─────────────────────────────────────────────────────────────────

program
  .command("devices <name>")
  .description("List paired devices for a tenant")
  .action(async (name: string) => {
    const result = await runExec(name, ["openclaw", "devices"]);

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    process.exit(result.value);
  });

// ── suspend ──────────────────────────────────────────────────────────────────

program
  .command("suspend <name>")
  .description("Suspend a tenant VM to disk (snapshot + kill)")
  .action(async (name: string) => {
    console.log(`Suspending tenant "${name}"...`);
    const result = await runSuspend(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const t = result.value;
    const nextWake = t.suspendInfo?.nextWakeAtMs
      ? `  Next cron wake: ${new Date(t.suspendInfo.nextWakeAtMs).toISOString()}`
      : "";
    console.log(`\nTenant "${t.name}" suspended.${nextWake}`);
  });

// ── resume ───────────────────────────────────────────────────────────────────

program
  .command("resume <name>")
  .description("Resume a suspended tenant VM from snapshot")
  .action(async (name: string) => {
    console.log(`Resuming tenant "${name}"...`);
    const result = await runResume(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const t = result.value;
    console.log(`\nTenant "${t.name}" resumed.`);
    console.log(
      `  CID: ${t.cid}  IP: ${t.ipAddress}  Port: ${t.gatewayPort}  PID: ${t.vmPid}`,
    );
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
  .description("Snapshot overlay as sparse tarball into ./snaps/")
  .option("--json", "Output result as JSON")
  .action(async (name: string, opts: { json?: boolean }) => {
    const result = await runSnap(name, opts);

    if (result.isErr()) {
      console.error(`✗ ${result.error.message}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result.value));
    } else {
      console.log(`Snapshot created: ${result.value.path}`);
    }
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

// ── buoy ─────────────────────────────────────────────────────────────────────

program
  .command("buoy")
  .description("Start the local REST API server")
  .option("-p, --port <port>", "Port to listen on", Number.parseInt)
  .option("-H, --host <host>", "Host to bind to")
  .action(async (opts: { port?: number; host?: string }) => {
    await startBuoy(opts);
  });

program.parse();
