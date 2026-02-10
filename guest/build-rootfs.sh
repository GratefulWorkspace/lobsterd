#!/bin/bash
set -euo pipefail

# build-rootfs.sh — Build a minimal Alpine rootfs for Firecracker microVMs
# Produces rootfs.ext4 with: Node.js, Docker CE, OpenClaw, and lobster-agent

ROOTFS_SIZE_MB=2048
ROOTFS_FILE="rootfs.ext4"
MOUNT_DIR="$(mktemp -d)"
ALPINE_MIRROR="https://dl-cdn.alpinelinux.org/alpine/v3.20"

cleanup() {
  umount "$MOUNT_DIR" 2>/dev/null || true
  rmdir "$MOUNT_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Creating ext4 image (${ROOTFS_SIZE_MB}MB)"
truncate -s "${ROOTFS_SIZE_MB}M" "$ROOTFS_FILE"
mkfs.ext4 -F -q "$ROOTFS_FILE"
mount -o loop "$ROOTFS_FILE" "$MOUNT_DIR"

echo "==> Installing Alpine base"
apk -X "$ALPINE_MIRROR/main" -U --allow-untrusted \
  --root "$MOUNT_DIR" --initdb \
  add alpine-base busybox openrc nodejs npm docker docker-openrc

echo "==> Setting up init system"
# Enable necessary services
ln -sf /etc/init.d/networking "$MOUNT_DIR/etc/runlevels/default/networking"
ln -sf /etc/init.d/docker "$MOUNT_DIR/etc/runlevels/default/docker"

# Configure serial console for Firecracker
cat > "$MOUNT_DIR/etc/inittab" <<'INITTAB'
::sysinit:/sbin/openrc sysinit
::sysinit:/sbin/openrc boot
::wait:/sbin/openrc default
::shutdown:/sbin/openrc shutdown
ttyS0::respawn:/sbin/getty -L 115200 ttyS0 vt100
INITTAB

# Configure DNS
echo "nameserver 8.8.8.8" > "$MOUNT_DIR/etc/resolv.conf"

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

echo "==> Installing OpenClaw"
mkdir -p "$MOUNT_DIR/opt/openclaw"
# OpenClaw binary/bundle should be placed here by CI or manually
# cp /path/to/openclaw.mjs "$MOUNT_DIR/opt/openclaw/openclaw.mjs"

echo "==> Cleanup"
rm -rf "$MOUNT_DIR/var/cache/apk"/*

umount "$MOUNT_DIR"
rmdir "$MOUNT_DIR"

echo "==> rootfs.ext4 built successfully ($(du -h "$ROOTFS_FILE" | cut -f1))"
