# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is lobsterd?

lobsterd is a Firecracker microVM tenant orchestrator. It manages isolated tenant VMs on a Linux host with KVM, providing per-tenant networking (TAP + iptables NAT), overlay filesystems, Caddy reverse proxy routing (`<name>.<domain>`), and a guest agent for host-to-VM communication.

## Commands

```bash
bun run typecheck     # TypeScript type checking (tsc --noEmit)
bun run lint          # Biome linting
bun run format        # Biome format + lint with auto-fix
bun run ci            # Full CI: biome format && lint && typecheck
```

There is no build step — the CLI runs directly via Bun (`./src/index.tsx`). No test framework is configured yet.

## Code Style

Enforced by Biome (biome.json):
- Double quotes, always semicolons, 2-space indent
- `noExplicitAny: error` — no `any` types
- `noUnusedVariables`, `noUnusedImports`, `noUnusedFunctionParameters`: all errors
- `useBlockStatements: error` — always use braces
- Imports are auto-organized

## Architecture

**Runtime:** Bun (ESM, TSX via react-jsx for Ink TUI components)

**Entry point:** `src/index.tsx` — Commander.js CLI with commands: init, spawn, evict, molt, snap, watch, tank, logs, token, buoy

**Source layout:**
- `src/commands/` — Command implementations. Each exports a `run*` function returning `ResultAsync<T, LobsterError>`
- `src/system/` — Low-level host operations: firecracker API, network (TAP/iptables), jailer, caddy admin API, vsock/TCP agent communication, overlay images, exec wrapper
- `src/config/` — Zod schemas, JSON config/registry I/O with file locking, provider model defaults
- `src/checks/` — Health check implementations (VM running, network reachable, agent responsive)
- `src/repair/` — Repair logic corresponding to failed checks
- `src/watchdog/` — Daemon that periodically runs checks and repairs, state machine (UNKNOWN → HEALTHY/DEGRADED/FAILED → RECOVERING)
- `src/reef/` — REST API server (buoy) using Hono + @hono/zod-openapi with bearer token auth
- `src/ui/` — React/Ink TUI components (interactive init, spawn flow, molt results, tank dashboard, watch display)
- `src/types/index.ts` — All shared TypeScript interfaces and types
- `guest/` — In-VM components: lobster-agent (Bun TCP server on ports 52/53), rootfs builder script, overlay-init (PID 1)

**Error handling:** Uses `neverthrow` (ResultAsync/Result) throughout — railway-oriented programming, not thrown exceptions. Commands return `ResultAsync<T, LobsterError>` where `LobsterError` has a typed `ErrorCode`.

**Config paths (on host):**
- `/etc/lobsterd/config.json` — System configuration (Zod-validated `LobsterdConfig`)
- `/etc/lobsterd/registry.json` — Tenant registry with file locking

**Per-tenant isolation:** Each tenant gets a Firecracker VM with jailer (chroot, UID/GID namespace, seccomp), a /30 subnet with TAP device, an overlay ext4 filesystem, and dedicated iptables chains (LOBSTER-INPUT/FORWARD/OUTPUT).
