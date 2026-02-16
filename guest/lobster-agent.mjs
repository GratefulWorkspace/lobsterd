#!/usr/bin/env bun

// lobster-agent.mjs — In-VM agent for lobsterd Firecracker microVMs
// Listens on TCP for host commands: inject-secrets, health-ping, launch-openclaw, shutdown
// Authenticated via agent_token passed in kernel command line.

import { execSync, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";

const VSOCK_PORT = 52;
const HEALTH_PORT = 53;
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB
let gatewayProcess = null;
let gatewayRestartCount = 0;
let gatewayStartedAt = 0;
let skipAutoRestart = false;
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
          handleMessage(msg).then(
            (response) => conn.end(`${response}\n`),
            (e) => conn.end(`${JSON.stringify({ error: e.message })}\n`),
          );
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
          handleMessage(msg).then(
            (response) => conn.end(`${response}\n`),
            (e) => conn.end(`${JSON.stringify({ error: e.message })}\n`),
          );
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

async function handleMessage(msg) {
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
    case "set-time":
      return handleSetTime(msg.timestampMs);
    case "get-cron-schedules":
      return await handleGetCronSchedules();
    case "restart-gateway":
      return await handleRestartGateway();
    case "ensure-gateway":
      return handleLaunchOpenclaw();
    case "get-active-connections":
      return handleGetActiveConnections();
    case "shutdown":
      return handleShutdown();
    default:
      return JSON.stringify({ error: `Unknown message type: ${msg.type}` });
  }
}

function handleSetTime(timestampMs) {
  if (typeof timestampMs !== "number" || timestampMs <= 0) {
    return JSON.stringify({ error: "Invalid timestampMs" });
  }
  try {
    const epochSeconds = Math.floor(timestampMs / 1000);
    execSync(`date -s @${epochSeconds}`, { stdio: "pipe" });
    console.log(
      `[lobster-agent] Clock set to ${new Date(timestampMs).toISOString()}`,
    );
    return JSON.stringify({ ok: true });
  } catch (e) {
    return JSON.stringify({ error: `Failed to set time: ${e.message}` });
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

  // Write SSH authorized key if provided
  if (newSecrets.SSH_AUTHORIZED_KEY) {
    try {
      mkdirSync("/root/.ssh", { recursive: true });
      chmodSync("/root/.ssh", 0o700);
      writeFileSync(
        "/root/.ssh/authorized_keys",
        `${newSecrets.SSH_AUTHORIZED_KEY}\n`,
        { mode: 0o600 },
      );
      console.log("[lobster-agent] Wrote SSH authorized key");
    } catch (e) {
      console.error(`[lobster-agent] Failed to write SSH key: ${e.message}`);
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
  gatewayProcess = spawn("bun", ["/opt/openclaw/openclaw.mjs", "gateway"], {
    env: {
      ...process.env,
      HOME: "/root",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: "9000",
      NODE_ENV: "production",
    },
    stdio: ["ignore", logFd, logFd],
  });

  gatewayStartedAt = Date.now();

  gatewayProcess.on("exit", (code) => {
    console.log(`[lobster-agent] Gateway process exited with code ${code}`);
    gatewayProcess = null;

    if (skipAutoRestart) {
      return;
    }

    // Reset counter if it ran for >60s (healthy run)
    const uptime = Date.now() - gatewayStartedAt;
    if (uptime > 60_000) {
      gatewayRestartCount = 0;
    } else {
      gatewayRestartCount++;
    }

    if (gatewayRestartCount <= 5) {
      console.log(
        `[lobster-agent] Auto-restarting gateway in 3s (attempt ${gatewayRestartCount}/5)`,
      );
      setTimeout(() => {
        if (!gatewayProcess && !skipAutoRestart) {
          handleLaunchOpenclaw();
        }
      }, 3000);
    } else {
      console.log(
        "[lobster-agent] Gateway exceeded max auto-restart attempts (5), giving up",
      );
    }
  });

  console.log(
    `[lobster-agent] Launched OpenClaw gateway (PID ${gatewayProcess.pid})`,
  );
  return JSON.stringify({ status: "launched", pid: gatewayProcess.pid });
}

async function handleRestartGateway() {
  skipAutoRestart = true;

  if (gatewayProcess) {
    const exitPromise = new Promise((resolve) => {
      gatewayProcess.on("exit", resolve);
    });
    gatewayProcess.kill("SIGTERM");
    await exitPromise;
  }

  gatewayRestartCount = 0;
  skipAutoRestart = false;
  return handleLaunchOpenclaw();
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

async function handleGetCronSchedules() {
  // Poke the gateway via cron.list RPC to trigger recomputeNextRuns(),
  // which persists fresh nextRunAtMs values to jobs.json
  const token = secrets.OPENCLAW_GATEWAY_TOKEN;
  if (token && gatewayProcess) {
    try {
      await refreshCronViaGateway(token);
    } catch (e) {
      console.log(`[lobster-agent] Gateway cron refresh failed: ${e.message}`);
    }
  }

  // Read the (now-fresh) file
  try {
    const raw = readFileSync("/root/.openclaw/cron/jobs.json", "utf-8");
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.jobs)) {
      return JSON.stringify({ schedules: [] });
    }
    const schedules = data.jobs
      .filter((j) => j.enabled !== false && j.state && j.state.nextRunAtMs > 0)
      .map((j) => ({
        id: j.id,
        name: j.name || j.id,
        nextRunAtMs: j.state.nextRunAtMs,
        schedule: j.schedule || null,
      }));
    return JSON.stringify({ schedules });
  } catch {
    return JSON.stringify({ schedules: [] });
  }
}

function refreshCronViaGateway(token) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(val);
      }
    };

    const timer = setTimeout(() => {
      settle(reject, new Error("timeout"));
      try {
        ws.close();
      } catch {}
    }, 5000);

    const ws = new WebSocket("ws://127.0.0.1:9000");
    let nextId = 1;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Step 1: Server sends connect challenge → send connect request
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const id = String(nextId++);
          ws.send(
            JSON.stringify({
              type: "req",
              id,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "lobster-agent",
                  version: "1.0.0",
                  platform: "linux",
                  mode: "backend",
                },
                role: "operator",
                scopes: ["operator.read"],
                auth: { token },
              },
            }),
          );
          return;
        }

        // Step 2: Connect response → send cron.list
        if (msg.type === "res" && msg.id === "1") {
          if (!msg.ok) {
            ws.close();
            settle(reject, new Error("connect rejected"));
            return;
          }
          const id = String(nextId++);
          ws.send(
            JSON.stringify({
              type: "req",
              id,
              method: "cron.list",
              params: {},
            }),
          );
          return;
        }

        // Step 3: cron.list response → done, file is now fresh
        if (msg.type === "res" && msg.id === "2") {
          ws.close();
          if (!msg.ok) {
            settle(reject, new Error("cron.list failed"));
            return;
          }
          settle(resolve, undefined);
        }
      } catch (e) {
        try {
          ws.close();
        } catch {}
        settle(reject, e);
      }
    };

    ws.onerror = () => {
      settle(reject, new Error("WebSocket connection failed"));
    };

    ws.onclose = () => {
      settle(reject, new Error("WebSocket closed before completion"));
    };
  });
}

function handleGetActiveConnections() {
  try {
    const tcp = readFileSync("/proc/net/tcp", "utf-8");
    const lines = tcp.trim().split("\n").slice(1); // skip header
    let count = 0;
    const GATEWAY_PORT = 0x2328; // 9000
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) {
        continue;
      }
      const localAddr = parts[1]; // hex ip:port
      const state = parts[3]; // connection state
      // state 01 = ESTABLISHED
      if (state !== "01") {
        continue;
      }
      // Only count inbound connections on the gateway port (9000).
      // This ignores outbound API calls, SSH, agent ports, and internal traffic.
      const localPort = parseInt(localAddr.split(":")[1], 16);
      if (localPort === GATEWAY_PORT) {
        count++;
      }
    }

    // Also check for running cron jobs — if any job has runningAtMs set,
    // the gateway is actively executing work even without inbound connections.
    try {
      const raw = readFileSync("/root/.openclaw/cron/jobs.json", "utf-8");
      const data = JSON.parse(raw);
      if (data.version === 1 && Array.isArray(data.jobs)) {
        const running = data.jobs.some(
          (j) =>
            j.enabled !== false &&
            j.state &&
            typeof j.state.runningAtMs === "number" &&
            j.state.runningAtMs > 0,
        );
        if (running) {
          count++;
        }
      }
    } catch {
      // No cron jobs file — ignore
    }

    return JSON.stringify({ activeConnections: count });
  } catch {
    return JSON.stringify({ activeConnections: 0 });
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
