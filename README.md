# lobsterd

Firecracker MicroVM Tenant Orchestrator. Spawns lightweight VMs with isolated
networking, per-tenant overlay filesystems, and an OpenClaw gateway in each guest.

## Prerequisites

**Host requirements:**

- Linux with KVM enabled (`/dev/kvm` must be accessible)
- Root access
- x86_64 architecture

**Install dependencies:**

```bash
# Bun (runtime)
curl -fsSL https://bun.sh/install | bash

# Caddy (reverse proxy)
apt-get install -y caddy

# Node.js + npm (needed on the host to build the guest rootfs)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Firecracker v1.14.1
ARCH="$(uname -m)"
curl -fSL "https://github.com/firecracker-microvm/firecracker/releases/download/v1.14.1/firecracker-v1.14.1-${ARCH}.tgz" \
  -o /tmp/firecracker.tgz
tar xzf /tmp/firecracker.tgz -C /tmp
install -m 0755 "/tmp/release-v1.14.1-${ARCH}/firecracker-v1.14.1-${ARCH}" /usr/local/bin/firecracker
```

## Kernel

Firecracker needs a bare vmlinux kernel image. **Use kernel 6.1 from the
Firecracker CI artifacts** -- the old quickstart 4.14 kernel is too old for
modern Node.js and will cause the guest agent to silently fail.

```bash
mkdir -p /var/lib/lobsterd/kernels

# Kernel 6.1.155 matched to Firecracker v1.14
curl -fSL "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.14/x86_64/vmlinux-6.1.155" \
  -o /var/lib/lobsterd/kernels/vmlinux
```

The general URL pattern for other versions:
```
https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v{FC_MINOR}/x86_64/vmlinux-{KERNEL_VERSION}
```

## Guest rootfs

Build the Alpine-based root filesystem image. This downloads Alpine 3.20,
installs Node.js, OpenClaw, and the lobster-agent, then produces a 2GB ext4 image.

```bash
cd guest
sudo bash build-rootfs.sh
sudo mv rootfs.ext4 /var/lib/lobsterd/rootfs.ext4
```

**Note:** The rootfs uses Alpine's native `nodejs` package (musl-linked). Alpine
3.20 ships Node.js 20, but OpenClaw requires Node >= 22.12.0. This is a known
issue -- the guest agent starts correctly but the OpenClaw gateway will not
launch until a musl-compatible Node 22 build is used in the rootfs.

## Setup

```bash
# Install project dependencies
bun install

# Initialize the host (checks KVM, Firecracker, kernel, rootfs; sets up
# directories, config, IP forwarding, and Caddy)
sudo bun src/index.tsx init
```

This creates:
- `/etc/lobsterd/config.json` -- main configuration
- `/etc/lobsterd/registry.json` -- tenant registry
- `/var/lib/lobsterd/overlays/` -- per-tenant overlay images
- `/var/lib/lobsterd/sockets/` -- Firecracker API sockets

## Usage

```bash
# Spawn a new tenant
sudo bun src/index.tsx spawn <name>

# List tenants
sudo bun src/index.tsx list

# Remove a tenant
sudo bun src/index.tsx evict <name>

# Health-check and repair tenants
sudo bun src/index.tsx molt [name]

# Start the watchdog daemon
sudo bun src/index.tsx watch [-d]

# TUI dashboard
sudo bun src/index.tsx tank

# Stream tenant logs
sudo bun src/index.tsx logs <name>

# Snapshot a tenant's overlay
sudo bun src/index.tsx snap <name>
```

## Architecture

Each tenant gets:
- A Firecracker microVM (2 vCPU, 512MB RAM by default)
- A /30 subnet with a dedicated TAP device and iptables NAT
- An overlay ext4 filesystem layered on top of the shared read-only rootfs
- A lobster-agent (TCP on port 52/53) for host-to-guest communication
- A Caddy reverse-proxy route at `<name>.lobster.local`

Networking uses kernel `ip=` boot parameter for static configuration inside the
guest and TAP + MASQUERADE on the host side. The agent listens for JSON-RPC
messages over TCP to inject secrets, launch the OpenClaw gateway, stream logs,
and handle shutdown.

## File layout

```
src/
  index.tsx           CLI entry point (commander)
  commands/           init, spawn, evict, molt, list, snap, watch, tank, logs
  system/             firecracker API, networking, caddy, overlay images, agent TCP
  config/             zod schemas, defaults, JSON loader with file locking
  checks/             VM and network health checks
  repair/             VM and network repair logic
  watchdog/           background monitoring loop and state machine
  ui/                 React/Ink TUI components
guest/
  build-rootfs.sh     Alpine rootfs builder
  lobster-agent.mjs   In-VM TCP agent
  overlay-init        PID 1 script (overlayfs + pivot_root)
```
