#!/bin/bash
set -euo pipefail

# build-rootfs.sh — Build a minimal Alpine rootfs for Firecracker microVMs
# Produces rootfs.ext4 with: Node.js, OpenClaw, and lobster-agent
# Runs on any Linux host (Ubuntu, etc.) — no apk required on host.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROOTFS_SIZE_MB=2048
ROOTFS_FILE="$SCRIPT_DIR/rootfs.ext4"
MOUNT_DIR="$(mktemp -d)"
ALPINE_VERSION="3.20"
ALPINE_ARCH="x86_64"
ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}"
MINIROOTFS_URL="${ALPINE_MIRROR}/releases/${ALPINE_ARCH}/alpine-minirootfs-3.20.6-${ALPINE_ARCH}.tar.gz"

cleanup() {
  umount "$MOUNT_DIR/proc" 2>/dev/null || true
  umount "$MOUNT_DIR/sys" 2>/dev/null || true
  umount "$MOUNT_DIR/dev" 2>/dev/null || true
  umount "$MOUNT_DIR" 2>/dev/null || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Creating ext4 image (${ROOTFS_SIZE_MB}MB)"
truncate -s "${ROOTFS_SIZE_MB}M" "$ROOTFS_FILE"
mkfs.ext4 -F -q "$ROOTFS_FILE"
mount -o loop "$ROOTFS_FILE" "$MOUNT_DIR"

echo "==> Downloading Alpine minirootfs"
curl -fSL "$MINIROOTFS_URL" | tar xz -C "$MOUNT_DIR"

echo "==> Configuring Alpine repositories"
cat > "$MOUNT_DIR/etc/apk/repositories" <<EOF
${ALPINE_MIRROR}/main
${ALPINE_MIRROR}/community
EOF
echo "nameserver 8.8.8.8" > "$MOUNT_DIR/etc/resolv.conf"

echo "==> Mounting /proc, /sys, /dev for chroot"
mount --bind /proc "$MOUNT_DIR/proc"
mount --bind /sys "$MOUNT_DIR/sys"
mount --bind /dev "$MOUNT_DIR/dev"

echo "==> Installing packages inside chroot"
chroot "$MOUNT_DIR" /bin/sh -c '
  set -e
  apk update
  apk add alpine-base openrc git curl unzip libstdc++ libgcc dropbear
'

echo "==> Installing Bun (musl build)"
BUN_VERSION="1.3.9"
curl -fSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64-musl.zip" \
  -o /tmp/bun.zip
unzip -o /tmp/bun.zip -d /tmp/bun-extract
install -m 0755 /tmp/bun-extract/bun-linux-x64-musl/bun "$MOUNT_DIR/usr/local/bin/bun"
rm -rf /tmp/bun.zip /tmp/bun-extract

echo "==> Setting up init system"
# Enable necessary services
ln -sf /etc/init.d/networking "$MOUNT_DIR/etc/runlevels/default/networking"

# Configure init (serial console disabled — 8250.nr_uarts=0 in boot args)
cat > "$MOUNT_DIR/etc/inittab" <<'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::shutdown:/sbin/openrc shutdown
INITTAB

# Password-less root
sed -i 's/^root:.*/root::0:0:root:\/root:\/bin\/sh/' "$MOUNT_DIR/etc/passwd"

echo "==> Configuring shell environment"
# Symlink bun into default PATH so it works in non-interactive SSH sessions
ln -sf /usr/local/bin/bun "$MOUNT_DIR/usr/bin/bun"
# Create openclaw wrapper in default PATH
cat > "$MOUNT_DIR/usr/bin/openclaw" <<'WRAPPER'
#!/bin/sh
exec /usr/local/bin/bun /opt/openclaw/openclaw.mjs "$@"
WRAPPER
chmod 0755 "$MOUNT_DIR/usr/bin/openclaw"

echo "==> Installing overlay-init"
install -m 0755 "$SCRIPT_DIR/overlay-init" "$MOUNT_DIR/sbin/overlay-init"

echo "==> Installing lobster-agent"
mkdir -p "$MOUNT_DIR/opt/lobster-agent"
install -m 0644 "$SCRIPT_DIR/lobster-agent.mjs" "$MOUNT_DIR/opt/lobster-agent/agent.mjs"

# Create agent service
cat > "$MOUNT_DIR/etc/init.d/lobster-agent" <<'SVC'
#!/sbin/openrc-run
name="lobster-agent"
command="/usr/local/bin/bun"
command_args="/opt/lobster-agent/agent.mjs"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
depend() {
  need net
}
SVC
chmod 0755 "$MOUNT_DIR/etc/init.d/lobster-agent"
ln -sf /etc/init.d/lobster-agent "$MOUNT_DIR/etc/runlevels/default/lobster-agent"

echo "==> Installing dropbear SSH server"
mkdir -p "$MOUNT_DIR/etc/dropbear"
mkdir -p -m 0700 "$MOUNT_DIR/root/.ssh"

cat > "$MOUNT_DIR/etc/init.d/dropbear" <<'SVC'
#!/sbin/openrc-run
name="dropbear"
description="Lightweight SSH server"
command="/usr/sbin/dropbear"
pidfile="/run/${RC_SVCNAME}.pid"

depend() {
  need net
}

start_pre() {
  # Generate host key on first boot (persisted in overlay)
  if [ ! -f /etc/dropbear/dropbear_ed25519_host_key ]; then
    dropbearkey -t ed25519 -f /etc/dropbear/dropbear_ed25519_host_key
  fi
}

start() {
  # Parse guest IP from kernel cmdline (ip=<client>::<gw>:<mask>::<dev>:off)
  local ip_param guest_ip
  ip_param=$(cat /proc/cmdline | tr ' ' '\n' | grep '^ip=' | head -1 | cut -d= -f2)
  guest_ip=$(echo "$ip_param" | cut -d: -f1)
  if [ -z "$guest_ip" ]; then
    guest_ip="0.0.0.0"
  fi

  ebegin "Starting ${name}"
  start-stop-daemon --start --pidfile "$pidfile" \
    --exec "$command" -- \
    -s -j -k -p "${guest_ip}:22" -P "$pidfile"
  eend $?
}
SVC
chmod 0755 "$MOUNT_DIR/etc/init.d/dropbear"
ln -sf /etc/init.d/dropbear "$MOUNT_DIR/etc/runlevels/default/dropbear"

echo "==> Installing OpenClaw (pre-built from npm)"
OPENCLAW_TMP="$(mktemp -d)"
cd "$OPENCLAW_TMP"
bun init -y > /dev/null 2>&1
bun add openclaw
cd -
mkdir -p "$MOUNT_DIR/opt/openclaw"
cp -a "$OPENCLAW_TMP/node_modules/openclaw"/* "$MOUNT_DIR/opt/openclaw/"
# Copy runtime dependencies alongside
cp -a "$OPENCLAW_TMP/node_modules" "$MOUNT_DIR/opt/openclaw/"
# Create openclaw.mjs entry point that lobster-agent expects
ln -sf /opt/openclaw/dist/entry.js "$MOUNT_DIR/opt/openclaw/openclaw.mjs"
# Remove llama.cpp bindings — not needed for gateway mode (~710MB)
rm -rf "$MOUNT_DIR/opt/openclaw/node_modules/@node-llama-cpp" \
       "$MOUNT_DIR/opt/openclaw/node_modules/node-llama-cpp"
rm -rf "$OPENCLAW_TMP"

echo "==> Hardening guest — removing package manager and unnecessary tools"
# Remove apk package manager to prevent tenants from installing attack tools
chroot "$MOUNT_DIR" /bin/sh -c '
  set -e
  rm -f /sbin/apk /usr/bin/apk
  rm -rf /etc/apk /var/cache/apk /lib/apk
'
# Note: dropbear is intentionally kept — provides SSH access for `lobsterd exec`
# Remove curl, git, unzip (only needed during build, not at runtime)
rm -f "$MOUNT_DIR/usr/bin/curl" "$MOUNT_DIR/usr/bin/git" "$MOUNT_DIR/usr/bin/unzip"
rm -rf "$MOUNT_DIR/usr/libexec/git-core"
# Remove wget if present
rm -f "$MOUNT_DIR/usr/bin/wget"
# Remove compilers and development tools
rm -f "$MOUNT_DIR/usr/bin/cc" "$MOUNT_DIR/usr/bin/gcc" "$MOUNT_DIR/usr/bin/g++"
# Remove busybox applets useful for recon/exploitation (nc, wget, telnet, ftp, etc.)
chroot "$MOUNT_DIR" /bin/sh -c '
  for applet in nc wget telnet ftp tftp ftpd httpd nslookup traceroute; do
    rm -f "/usr/bin/$applet" "/bin/$applet" "/sbin/$applet"
  done
'
# Lock root password (passwordless login was for build only; serial console is disabled)
sed -i 's/^root::/root:!:/' "$MOUNT_DIR/etc/passwd"

echo "==> Cleanup"
umount "$MOUNT_DIR/proc" "$MOUNT_DIR/sys" "$MOUNT_DIR/dev"
echo "nameserver 8.8.8.8" > "$MOUNT_DIR/etc/resolv.conf"
rm -rf "$MOUNT_DIR/var/cache/apk"/*
rm -rf "$MOUNT_DIR/root/.bun" "$MOUNT_DIR/tmp"/*

umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "==> rootfs.ext4 built successfully ($(du -h "$ROOTFS_FILE" | cut -f1))"
