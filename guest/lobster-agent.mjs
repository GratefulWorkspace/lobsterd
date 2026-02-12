#!/usr/bin/env bun

// lobster-agent.mjs — In-VM agent for lobsterd Firecracker microVMs
// Listens on TCP for host commands: inject-secrets, health-ping, launch-openclaw, shutdown
// Authenticated via agent_token passed in kernel command line.

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const VSOCK_PORT = 52;
const HEALTH_PORT = 53;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
let gatewayProcess = null;
let secrets = {};

/** Parse a key=value parameter from /proc/cmdline */
function parseCmdlineParam(key) {
  try {
    const cmdline = readFileSync("/proc/cmdline", "utf-8").trim();
    for (const param of cmdline.split(/\s+/)) {
      const [k, ...rest] = param.split("=");
      if (k === key) {
        return rest.join("=");
      }
    }
  } catch {}
  return null;
}

/** Extract guest IP from kernel ip= parameter (ip=<client>::<gw>:<mask>::<dev>:off) */
function parseGuestIp() {
  const ipParam = parseCmdlineParam("ip");
  if (ipParam) {
    const guestIp = ipParam.split(":")[0];
    if (guestIp && /^\d+\.\d+\.\d+\.\d+$/.test(guestIp)) {
      return guestIp;
    }
  }
  return "0.0.0.0"; // Fallback
}

const AGENT_TOKEN = parseCmdlineParam("agent_token");
const BIND_ADDR = parseGuestIp();

function validateToken(msg) {
  if (!AGENT_TOKEN) {
    return false; // No token configured — deny all
  }
  if (!msg || typeof msg.token !== "string") {
    return false;
  }
  const expected = Buffer.from(AGENT_TOKEN, "utf-8");
  const received = Buffer.from(msg.token, "utf-8");
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

function startAgent() {
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    let data = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > MAX_MESSAGE_SIZE) {
        conn.end(`${JSON.stringify({ error: "message too large" })}\n`);
        conn.destroy();
        return;
      }
      if (data.includes("\n")) {
        try {
          const msg = JSON.parse(data.trim());
          if (!validateToken(msg)) {
            conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
            return;
          }
          const response = handleMessage(msg);
          conn.end(`${response}\n`);
        } catch (e) {
          conn.end(`${JSON.stringify({ error: e.message })}\n`);
        }
      }
    });
    conn.on("end", () => {
      if (data.length > 0 && !data.includes("\n")) {
        try {
          const msg = JSON.parse(data.trim());
          if (!validateToken(msg)) {
            conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
            return;
          }
          const response = handleMessage(msg);
          conn.end(`${response}\n`);
        } catch (e) {
          conn.end(`${JSON.stringify({ error: e.message })}\n`);
        }
      }
    });
  });

  server.listen(VSOCK_PORT, BIND_ADDR, () => {
    console.log(`[lobster-agent] Listening on ${BIND_ADDR}:${VSOCK_PORT}`);
  });

  // Health ping listener on separate port
  const healthServer = createServer((conn) => {
    let data = "";
    conn.on("error", () => {});
    conn.on("data", (chunk) => {
      data += chunk.toString();
      if (data.length > MAX_MESSAGE_SIZE) {
        conn.end(`${JSON.stringify({ error: "message too large" })}\n`);
        conn.destroy();
        return;
      }
      if (data.includes("\n") || data.length > 0) {
        try {
          const msg = JSON.parse(data.trim());
          if (!validateToken(msg)) {
            conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
            return;
          }
          conn.end("PONG\n");
        } catch {
          conn.end(`${JSON.stringify({ error: "unauthorized" })}\n`);
        }
      }
    });
  });

  healthServer.listen(HEALTH_PORT, BIND_ADDR, () => {
    console.log(
      `[lobster-agent] Health listener on ${BIND_ADDR}:${HEALTH_PORT}`,
    );
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case "inject-secrets":
      return handleInjectSecrets(msg.secrets);
    case "health-ping":
      return "PONG";
    case "launch-openclaw":
      return handleLaunchOpenclaw();
    case "get-stats":
      return handleGetStats();
    case "get-logs":
      try {
        return readFileSync("/tmp/openclaw-gateway.log", "utf-8").slice(-4000);
      } catch {
        return "No logs available";
      }
    case "shutdown":
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
      mkdirSync("/root/.openclaw", { recursive: true });
      writeFileSync("/root/.openclaw/openclaw.json", secrets.OPENCLAW_CONFIG);
      console.log("[lobster-agent] Wrote OpenClaw config");
    } catch (e) {
      console.error(`[lobster-agent] Failed to write config: ${e.message}`);
    }
  }

  // Launch OpenClaw gateway if we have the token
  if (secrets.OPENCLAW_GATEWAY_TOKEN && !gatewayProcess) {
    handleLaunchOpenclaw();
  }

  return "ACK";
}

function handleLaunchOpenclaw() {
  if (gatewayProcess) {
    return JSON.stringify({
      status: "already-running",
      pid: gatewayProcess.pid,
    });
  }

  const token = secrets.OPENCLAW_GATEWAY_TOKEN;
  if (!token) {
    return JSON.stringify({ error: "No gateway token available" });
  }

  const logFd = openSync("/tmp/openclaw-gateway.log", "a");
  gatewayProcess = spawn(
    "bun",
    ["/opt/openclaw/openclaw.mjs", "gateway", "--bind", "lan"],
    {
      env: {
        ...process.env,
        HOME: "/root",
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_GATEWAY_PORT: "9000",
        NODE_ENV: "production",
      },
      stdio: ["ignore", logFd, logFd],
    },
  );

  gatewayProcess.on("exit", (code) => {
    console.log(`[lobster-agent] Gateway process exited with code ${code}`);
    gatewayProcess = null;
  });

  console.log(
    `[lobster-agent] Launched OpenClaw gateway (PID ${gatewayProcess.pid})`,
  );
  return JSON.stringify({ status: "launched", pid: gatewayProcess.pid });
}

function handleGetStats() {
  if (!gatewayProcess || !gatewayProcess.pid) {
    return JSON.stringify({ gatewayPid: null, memoryKb: 0 });
  }
  try {
    const status = readFileSync(`/proc/${gatewayProcess.pid}/status`, "utf-8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const memoryKb = match ? parseInt(match[1], 10) : 0;
    return JSON.stringify({ gatewayPid: gatewayProcess.pid, memoryKb });
  } catch {
    return JSON.stringify({ gatewayPid: gatewayProcess.pid, memoryKb: 0 });
  }
}

function handleShutdown() {
  console.log("[lobster-agent] Shutdown requested");
  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
  }
  setTimeout(() => {
    spawn("poweroff", [], { stdio: "inherit" });
  }, 1000);
  return "ACK";
}

// Start
startAgent();
