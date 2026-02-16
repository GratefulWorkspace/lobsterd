#!/usr/bin/env bun

// lobster-agent.mjs — In-VM agent for lobsterd Firecracker microVMs
// Listens on TCP for host commands: inject-secrets, health-ping, launch-openclaw, shutdown
// Authenticated via agent_token passed in kernel command line.

import { execSync, spawn } from "node:child_process";
import crypto, { timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";

// Ed25519 device identity for OpenClaw gateway auth (scopes require device)
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);
const deviceKeypair = crypto.generateKeyPairSync("ed25519");
const devicePublicKeyRaw = (() => {
  const spki = deviceKeypair.publicKey.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
})();
const deviceId = crypto
  .createHash("sha256")
  .update(devicePublicKeyRaw)
  .digest("hex");
const devicePublicKeyB64 = devicePublicKeyRaw.toString("base64url");

/** Build device auth object for gateway connect messages */
function buildDeviceAuth(token, scopes) {
  const signedAtMs = Date.now();
  const payload = [
    "v1",
    deviceId,
    "gateway-client",
    "backend",
    "operator",
    scopes.join(","),
    String(signedAtMs),
    token || "",
  ].join("|");
  const signature = crypto
    .sign(null, Buffer.from(payload, "utf8"), deviceKeypair.privateKey)
    .toString("base64url");
  return {
    id: deviceId,
    publicKey: devicePublicKeyB64,
    signature,
    signedAt: signedAtMs,
  };
}

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
    case "poke-cron":
      return await handlePokeCron();
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

  gatewayProcess.on("exit", (code) => {
    console.log(`[lobster-agent] Gateway process exited with code ${code}`);
    gatewayProcess = null;
  });

  console.log(
    `[lobster-agent] Launched OpenClaw gateway (PID ${gatewayProcess.pid})`,
  );
  return JSON.stringify({ status: "launched", pid: gatewayProcess.pid });
}

async function handlePokeCron() {
  const token = secrets.OPENCLAW_GATEWAY_TOKEN;
  if (!token || !gatewayProcess) {
    return JSON.stringify({ error: "Gateway not running" });
  }

  // Read jobs.json to find enabled jobs with their nextRunAtMs
  let jobs = [];
  try {
    const raw = readFileSync("/root/.openclaw/cron/jobs.json", "utf-8");
    const data = JSON.parse(raw);
    if (data.version === 1 && Array.isArray(data.jobs)) {
      jobs = data.jobs.filter(
        (j) =>
          j.enabled !== false &&
          j.state &&
          typeof j.state.nextRunAtMs === "number",
      );
    }
  } catch {
    return JSON.stringify({ error: "No cron jobs found" });
  }

  if (jobs.length === 0) {
    return JSON.stringify({ ok: true, triggered: 0, deferred: 0 });
  }

  const now = Date.now();
  const overdue = jobs.filter((j) => now >= j.state.nextRunAtMs);
  const upcoming = jobs.filter((j) => now < j.state.nextRunAtMs);

  // Execute overdue jobs immediately (no mode = defaults to "force")
  let triggered = 0;
  if (overdue.length > 0) {
    try {
      triggered = await runCronJobs(
        token,
        overdue.map((j) => j.id),
      );
    } catch (e) {
      console.log(`[lobster-agent] Poke cron (overdue) failed: ${e.message}`);
    }
  }

  // Schedule deferred triggers for upcoming jobs. Fire 15s AFTER the
  // scheduled cron time — this gives OpenClaw's own stale timer a
  // chance to handle it naturally. Our cron.run(due) acts as the
  // safety net: if OpenClaw already ran the job, "due" returns
  // not-due (no-op); if it didn't, we catch it.
  const POKE_DELAY_MS = 5_000;
  for (const job of upcoming) {
    const delay = job.state.nextRunAtMs - now + POKE_DELAY_MS;
    console.log(
      `[lobster-agent] Deferring cron.run for ${job.id} in ${Math.round(delay / 1000)}s`,
    );
    setTimeout(async () => {
      try {
        await runCronJobs(token, [job.id], "due");
      } catch (e) {
        console.log(
          `[lobster-agent] Deferred cron trigger for ${job.id} failed: ${e.message}`,
        );
      }
    }, delay);
  }

  return JSON.stringify({ ok: true, triggered, deferred: upcoming.length });
}

/** Connect to gateway WebSocket and call cron.run for each job ID */
function runCronJobs(token, jobIds, mode) {
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
    }, 10000);

    const ws = new WebSocket("ws://127.0.0.1:9000");
    let nextId = 1;
    let triggered = 0;
    let pendingJobIdx = 0;

    function sendNextJobOrFinish() {
      if (pendingJobIdx >= jobIds.length) {
        ws.close();
        settle(resolve, triggered);
        return;
      }
      const id = String(nextId++);
      const params = { jobId: jobIds[pendingJobIdx] };
      if (mode) {
        params.mode = mode;
      }
      ws.send(JSON.stringify({ type: "req", id, method: "cron.run", params }));
      pendingJobIdx++;
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Step 1: Server sends connect challenge → authenticate
        if (msg.type === "event" && msg.event === "connect.challenge") {
          const id = String(nextId++);
          const scopes = ["operator.admin"];
          ws.send(
            JSON.stringify({
              type: "req",
              id,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "linux",
                  mode: "backend",
                },
                role: "operator",
                scopes,
                auth: { token },
                device: buildDeviceAuth(token, scopes),
              },
            }),
          );
          return;
        }

        // Step 2: Connect response → start sending cron.run requests
        if (msg.type === "res" && msg.id === "1") {
          if (!msg.ok) {
            ws.close();
            settle(reject, new Error("connect rejected"));
            return;
          }
          sendNextJobOrFinish();
          return;
        }

        // Step 3+: cron.run responses → send next or finish
        if (msg.type === "res") {
          if (msg.ok) {
            triggered++;
          }
          sendNextJobOrFinish();
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
          const scopes = ["operator.admin"];
          ws.send(
            JSON.stringify({
              type: "req",
              id,
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                  id: "gateway-client",
                  version: "1.0.0",
                  platform: "linux",
                  mode: "backend",
                },
                role: "operator",
                scopes,
                auth: { token },
                device: buildDeviceAuth(token, scopes),
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
