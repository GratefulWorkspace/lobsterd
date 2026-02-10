#!/usr/bin/env node

// lobster-agent.mjs — In-VM agent for lobsterd Firecracker microVMs
// Listens on TCP for host commands: inject-secrets, health-ping, launch-openclaw, shutdown

import { createServer } from 'net';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';

const VSOCK_PORT = 52;
const HEALTH_PORT = 53;
let gatewayProcess = null;
let secrets = {};

function startAgent() {
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let data = '';
    conn.on('data', (chunk) => {
      data += chunk.toString();
      // Process when we get a newline (message delimiter)
      if (data.includes('\n')) {
        try {
          const msg = JSON.parse(data.trim());
          const response = handleMessage(msg);
          conn.end(response + '\n');
        } catch (e) {
          conn.end(JSON.stringify({ error: e.message }) + '\n');
        }
      }
    });
    conn.on('end', () => {
      // If no newline was received yet, try to process what we have
      if (data.length > 0 && !data.includes('\n')) {
        try {
          const msg = JSON.parse(data.trim());
          const response = handleMessage(msg);
          conn.end(response + '\n');
        } catch (e) {
          conn.end(JSON.stringify({ error: e.message }) + '\n');
        }
      }
    });
  });

  server.listen(VSOCK_PORT, '0.0.0.0', () => {
    console.log(`[lobster-agent] Listening on 0.0.0.0:${VSOCK_PORT}`);
  });

  // Health ping listener on separate port
  const healthServer = createServer({ allowHalfOpen: true }, (conn) => {
    let data = '';
    conn.on('data', () => {
      conn.end('PONG\n');
    });
    conn.on('end', () => {
      if (!data) conn.end('PONG\n');
    });
  });

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`[lobster-agent] Health listener on 0.0.0.0:${HEALTH_PORT}`);
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
