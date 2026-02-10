#!/usr/bin/env node

// lobster-agent.mjs — In-VM agent for lobsterd Firecracker microVMs
// Listens on vsock for host commands: inject-secrets, health-ping, launch-openclaw, shutdown

import { createServer } from 'net';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';

const VSOCK_PORT = 52;
const HEALTH_PORT = 53;
let gatewayProcess = null;
let secrets = {};

// vsock listener using socat bridge (AF_VSOCK requires native support)
// The agent listens on a UNIX socket and socat bridges vsock to it
function startAgent() {
  const server = createServer((conn) => {
    let data = '';
    conn.on('data', (chunk) => {
      data += chunk.toString();
    });
    conn.on('end', () => {
      try {
        const msg = JSON.parse(data.trim());
        const response = handleMessage(msg);
        conn.write(response + '\n');
      } catch (e) {
        conn.write(JSON.stringify({ error: e.message }) + '\n');
      }
      conn.end();
    });
  });

  server.listen(`/tmp/lobster-agent.sock`, () => {
    console.log(`[lobster-agent] Listening on /tmp/lobster-agent.sock`);
    // Start socat bridge: vsock -> unix socket
    spawn('socat', [
      `VSOCK-LISTEN:${VSOCK_PORT},reuseaddr,fork`,
      'UNIX-CONNECT:/tmp/lobster-agent.sock',
    ], { stdio: 'inherit' });
  });

  // Health ping listener on separate port
  const healthServer = createServer((conn) => {
    let data = '';
    conn.on('data', (chunk) => { data += chunk.toString(); });
    conn.on('end', () => {
      conn.write('PONG\n');
      conn.end();
    });
  });

  healthServer.listen('/tmp/lobster-health.sock', () => {
    console.log(`[lobster-agent] Health listener on /tmp/lobster-health.sock`);
    spawn('socat', [
      `VSOCK-LISTEN:${HEALTH_PORT},reuseaddr,fork`,
      'UNIX-CONNECT:/tmp/lobster-health.sock',
    ], { stdio: 'inherit' });
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'inject-secrets':
      return handleInjectSecrets(msg.secrets);
    case 'health-ping':
      return 'PONG';
    case 'launch-openclaw':
      return handleLaunchOpenclaw();
    case 'shutdown':
      return handleShutdown();
    default:
      return JSON.stringify({ error: `Unknown message type: ${msg.type}` });
  }
}

function handleInjectSecrets(newSecrets) {
  secrets = { ...secrets, ...newSecrets };

  // Write OpenClaw config if provided
  if (secrets.OPENCLAW_CONFIG) {
    try {
      mkdirSync('/root/.openclaw', { recursive: true });
      writeFileSync('/root/.openclaw/openclaw.json', secrets.OPENCLAW_CONFIG);
      console.log('[lobster-agent] Wrote OpenClaw config');
    } catch (e) {
      console.error(`[lobster-agent] Failed to write config: ${e.message}`);
    }
  }

  // Launch OpenClaw gateway if we have the token
  if (secrets.OPENCLAW_GATEWAY_TOKEN && !gatewayProcess) {
    handleLaunchOpenclaw();
  }

  return 'ACK';
}

function handleLaunchOpenclaw() {
  if (gatewayProcess) {
    return JSON.stringify({ status: 'already-running', pid: gatewayProcess.pid });
  }

  const token = secrets.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return JSON.stringify({ error: 'No gateway token available' });
  }

  gatewayProcess = spawn('node', [
    '/opt/openclaw/openclaw.mjs',
    'gateway',
    '--port', '9000',
    '--auth', 'token',
    '--bind', '0.0.0.0',
  ], {
    env: {
      ...process.env,
      HOME: '/root',
      OPENCLAW_GATEWAY_TOKEN: token,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  gatewayProcess.on('exit', (code) => {
    console.log(`[lobster-agent] Gateway process exited with code ${code}`);
    gatewayProcess = null;
  });

  console.log(`[lobster-agent] Launched OpenClaw gateway (PID ${gatewayProcess.pid})`);
  return JSON.stringify({ status: 'launched', pid: gatewayProcess.pid });
}

function handleShutdown() {
  console.log('[lobster-agent] Shutdown requested');
  if (gatewayProcess) {
    gatewayProcess.kill('SIGTERM');
  }
  setTimeout(() => {
    spawn('poweroff', [], { stdio: 'inherit' });
  }, 1000);
  return 'ACK';
}

// Start
startAgent();
