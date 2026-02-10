#!/bin/bash
set -euo pipefail

# build-rootfs.sh — Build a minimal Alpine rootfs for Firecracker microVMs
# Produces rootfs.ext4 with: Node.js, OpenClaw, and lobster-agent
# Runs on any Linux host (Ubuntu, etc.) — no apk required on host.

ROOTFS_SIZE_MB=2048
ROOTFS_FILE="rootfs.ext4"
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
  apk add alpine-base openrc git curl nodejs npm
'

echo "==> Setting up init system"
# Enable necessary services
ln -sf /etc/init.d/networking "$MOUNT_DIR/etc/runlevels/default/networking"

# Configure serial console for Firecracker
cat > "$MOUNT_DIR/etc/inittab" <<'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::shutdown:/sbin/openrc shutdown
ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100
INITTAB

# Password-less root
sed -i 's/^root:.*/root::0:0:root:\/root:\/bin\/sh/' "$MOUNT_DIR/etc/passwd"

echo "==> Installing overlay-init"
install -m 0755 overlay-init "$MOUNT_DIR/sbin/overlay-init"

echo "==> Installing lobster-agent"
mkdir -p "$MOUNT_DIR/opt/lobster-agent"
install -m 0644 lobster-agent.mjs "$MOUNT_DIR/opt/lobster-agent/agent.mjs"

# Create agent service
cat > "$MOUNT_DIR/etc/init.d/lobster-agent" <<'SVC'
#!/sbin/openrc-run
name="lobster-agent"
command="/usr/bin/node"
command_args="/opt/lobster-agent/agent.mjs"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
depend() {
  need net
}
SVC
chmod 0755 "$MOUNT_DIR/etc/init.d/lobster-agent"
ln -sf /etc/init.d/lobster-agent "$MOUNT_DIR/etc/runlevels/default/lobster-agent"

echo "==> Installing OpenClaw (pre-built from npm)"
OPENCLAW_TMP="$(mktemp -d)"
cd "$OPENCLAW_TMP"
npm init -y > /dev/null 2>&1
npm install openclaw
cd -
mkdir -p "$MOUNT_DIR/opt/openclaw"
cp -a "$OPENCLAW_TMP/node_modules/openclaw"/* "$MOUNT_DIR/opt/openclaw/"
# Copy runtime dependencies alongside
cp -a "$OPENCLAW_TMP/node_modules" "$MOUNT_DIR/opt/openclaw/"
# Create openclaw.mjs entry point that lobster-agent expects
ln -sf /opt/openclaw/dist/entry.js "$MOUNT_DIR/opt/openclaw/openclaw.mjs"
rm -rf "$OPENCLAW_TMP"

echo "==> Cleanup"
umount "$MOUNT_DIR/proc" "$MOUNT_DIR/sys" "$MOUNT_DIR/dev"
echo "nameserver 8.8.8.8" > "$MOUNT_DIR/etc/resolv.conf"
rm -rf "$MOUNT_DIR/var/cache/apk"/*
rm -rf "$MOUNT_DIR/root/.npm" "$MOUNT_DIR/tmp"/*

umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "==> rootfs.ext4 built successfully ($(du -h "$ROOTFS_FILE" | cut -f1))"
