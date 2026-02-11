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
Bun/Node.js and will cause the guest agent to silently fail.

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
installs Bun (musl build), OpenClaw (with llama.cpp stripped for size), and the
lobster-agent, then produces an ext4 image.

```bash
cd guest
sudo bash build-rootfs.sh
sudo mv rootfs.ext4 /var/lib/lobsterd/rootfs.ext4
```

## Setup

```bash
# Install dependencies and link the lobsterd CLI
bun install

# Initialize the host (checks KVM, Firecracker, kernel, rootfs; sets up
# directories, config, IP forwarding, and Caddy)
sudo lobsterd init
```

This creates:
- `/etc/lobsterd/config.json` -- main configuration
- `/etc/lobsterd/registry.json` -- tenant registry
- `/var/lib/lobsterd/overlays/` -- per-tenant overlay images
- `/var/lib/lobsterd/sockets/` -- Firecracker API sockets

## Usage

```bash
# Spawn a new tenant
sudo lobsterd spawn <name>

# List tenants
sudo lobsterd list

# Remove a tenant
sudo lobsterd evict <name>

# Health-check and repair tenants
sudo lobsterd molt [name]

# Start the watchdog daemon
sudo lobsterd watch [-d]

# TUI dashboard
sudo lobsterd tank

# Stream tenant logs
sudo lobsterd logs <name>

# Snapshot a tenant's overlay
sudo lobsterd snap <name>
```

## Architecture

Each tenant gets:
- A Firecracker microVM (2 vCPU, 1024MB RAM by default)
- A /30 subnet with a dedicated TAP device and iptables NAT
- An overlay ext4 filesystem layered on top of the shared read-only rootfs
- A lobster-agent (TCP on port 52/53) for host-to-guest communication
- A Caddy reverse-proxy route at `<name>.gradeprompt.com`

Networking uses kernel `ip=` boot parameter for static configuration inside the
guest and TAP + MASQUERADE on the host side. The agent listens for JSON-RPC
messages over TCP to inject secrets, launch the OpenClaw gateway, stream logs,
and handle shutdown.

### VM isolation

Every VM runs inside the Firecracker **jailer**, which provides per-tenant
UID/GID, a chroot filesystem, PID/mount/network namespaces, and a default
seccomp BPF filter (~35 allowed syscalls). Cgroup v2 resource limits cap memory
at 1.5x the VM's configured RAM and CPU quota proportional to its vCPU count,
preventing any single tenant from starving the host. The vsock device has been
removed entirely to eliminate virtio-vsock emulation as a guest-reachable attack
surface, leaving only four virtio devices (block x2, net, keyboard).

### Network isolation

Tenant traffic flows through dedicated `LOBSTER-INPUT` and `LOBSTER-FORWARD`
iptables chains, inserted at position 1 in the built-in INPUT and FORWARD
chains. Per-tenant rules block guest-to-host access, RFC 1918 ranges
(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), and link-local (169.254.0.0/16).
Only return traffic and inbound connections to the tenant's gateway port are
accepted.

DNAT rules in PREROUTING exclude `10.0.0.0/8` as a source, preventing
cross-tenant access through host-side port forwarding. Each tenant is limited to
1024 concurrent connections via `connlimit` to prevent conntrack table
exhaustion. IPv6 is disabled on all TAP devices. Network throughput is rate
limited to 10 Mbps RX/TX at 1K ops/s; disk I/O is limited to 50 MB/s at 5K
ops/s.

### Guest hardening

All tenants share a read-only Alpine 3.20 rootfs with per-tenant writable
overlays via overlayfs. The rootfs is stripped after build: the apk package
manager, curl, git, wget, and compilers are removed, along with busybox applets
useful for reconnaissance or exploitation (nc, telnet, ftp, tftp, httpd,
traceroute, nslookup). The root account is locked and the serial console is
disabled (`8250.nr_uarts=0` in kernel boot args, getty removed from inittab).

### Agent auth

The lobster-agent inside each VM authenticates host commands using a per-tenant
UUID token passed via the kernel command line. Authentication uses timing-safe
comparison and is fail-closed: if the token is missing or invalid, all requests
are rejected. Messages are capped at 1 MB to prevent memory exhaustion.

### TLS termination

Caddy terminates TLS for all tenant routes using ACME or bundled Cloudflare
origin certificates. The origin private key is stored with `0640 root:caddy`
permissions so only root and the Caddy process can read it.

See [SECURITY.md](SECURITY.md) for the full threat model, architectural limits
of KVM-based isolation, and recommended host configuration (SMT, KSM, conntrack
tuning).

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
