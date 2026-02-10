#!/usr/bin/env bun
import { Command } from 'commander';
import React from 'react';
import { render } from 'ink';
import { runInit } from './commands/init.js';
import { runSpawn } from './commands/spawn.js';
import { runEvict } from './commands/evict.js';
import { runMolt } from './commands/molt.js';
import { runList, formatTable } from './commands/list.js';
import { runSnap } from './commands/snap.js';
import { runWatch } from './commands/watch.js';
import { runTank } from './commands/tank.js';
import { runLogs } from './commands/logs.js';
import { MoltResults } from './ui/MoltProgress.js';

const program = new Command();

program
  .name('lobster')
  .description('🦞 lobsterd — Multi-Tenant OpenClaw Watchdog & Orchestrator')
  .version('0.1.0');

// ── init ──────────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize host (check kernel, deps, ZFS pool)')
  .action(async () => {
    console.log('🦞 Initializing lobsterd host...');
    const result = await runInit();

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const r = result.value;
    console.log(`  Kernel: ${r.kernel}`);
    console.log(`  ZFS: ${r.zfsAvailable ? 'available' : 'not found'}`);
    console.log(`  Parent dataset: ${r.parentDatasetCreated ? 'created' : 'already exists'}`);
    console.log(`  Config: ${r.configCreated ? 'written' : 'already exists'}`);
    console.log('\n● Host initialized successfully.');
  });

// ── spawn ─────────────────────────────────────────────────────────────────────

program
  .command('spawn <name>')
  .description('Add a new tenant')
  .action(async (name: string) => {
    console.log(`🦞 Spawning tenant "${name}"...`);
    const result = await runSpawn(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const t = result.value;
    console.log(`\n● Tenant "${t.name}" spawned successfully.`);
    console.log(`  UID: ${t.uid}  Port: ${t.gatewayPort}  Home: ${t.homePath}`);
  });

// ── evict ─────────────────────────────────────────────────────────────────────

program
  .command('evict <name>')
  .description('Remove a tenant (with confirmation)')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (name: string, opts: { yes?: boolean }) => {
    if (!opts.yes) {
      process.stdout.write(`Remove tenant "${name}"? This destroys all data. [y/N] `);
      const response = await new Promise<string>((resolve) => {
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (data) => resolve(data.toString().trim()));
        process.stdin.resume();
      });
      if (response.toLowerCase() !== 'y') {
        console.log('Aborted.');
        process.exit(0);
      }
    }

    console.log(`🦞 Evicting tenant "${name}"...`);
    const result = await runEvict(name, (p) => {
      console.log(`  [${p.step}] ${p.detail}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    console.log(`\n● Tenant "${name}" evicted.`);
  });

// ── molt ──────────────────────────────────────────────────────────────────────

program
  .command('molt [name]')
  .description('Idempotent repair — one tenant or all')
  .action(async (name?: string) => {
    const target = name ? `tenant "${name}"` : 'all tenants';
    console.log(`🦞 Molting ${target}...`);

    const result = await runMolt(name, (p) => {
      console.log(`  [${p.tenant}] ${p.phase}${p.detail ? `: ${p.detail}` : ''}`);
    });

    if (result.isErr()) {
      console.error(`\n✗ ${result.error.message}`);
      process.exit(1);
    }

    const results = result.value;
    const { unmount } = render(<MoltResults results={results} />);
    // Give Ink a frame to render, then unmount
    await new Promise((r) => setTimeout(r, 100));
    unmount();

    const allHealthy = results.every((r) => r.healthy);
    process.exit(allHealthy ? 0 : 1);
  });

// ── list ──────────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List tenants with status')
  .option('--json', 'Output as JSON')
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
  .command('snap <name>')
  .description('Take ZFS snapshot')
  .option('--prune', 'Prune old snapshots beyond retention')
  .action(async (name: string, opts: { prune?: boolean }) => {
    const result = await runSnap(name, opts);

    if (result.isErr()) {
      console.error(`✗ ${result.error.message}`);
      process.exit(1);
    }

    console.log(`● Snapshot created: ${result.value}`);
  });

// ── watch ─────────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Start watchdog (TUI foreground, or --daemon)')
  .option('-d, --daemon', 'Run as daemon (log to console)')
  .action(async (opts: { daemon?: boolean }) => {
    const code = await runWatch(opts);
    process.exit(code);
  });

// ── tank ──────────────────────────────────────────────────────────────────────

program
  .command('tank')
  .description('TUI dashboard showing all tenant health')
  .action(async () => {
    const code = await runTank();
    process.exit(code);
  });

// ── logs ──────────────────────────────────────────────────────────────────────

program
  .command('logs <name>')
  .description('Stream tenant logs')
  .option('-s, --service <service>', 'Service to stream logs for', 'openclaw-gateway')
  .action(async (name: string, opts: { service?: string }) => {
    const code = await runLogs(name, opts);
    process.exit(code);
  });

program.parse();
