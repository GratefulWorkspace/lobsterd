# Security Hardening — Remaining Items

Findings from a tenant-escape-focused security audit. The items below remain after the initial hardening pass (branch `security-hardening`), which addressed jailer integration, network isolation, rate limiting, agent auth, serial console, and rootfs lockdown.

## Known Issue

- **Hardcoded API key** — A Fireworks AI API key is committed in `src/config/defaults.ts`. Every tenant receives it via secret injection. Move to an environment variable or external secret store before any production use.

## Architectural Limits

These are inherent to Firecracker/KVM and cannot be resolved in application code.

- **KVM is the trust boundary.** A KVM guest-to-host escape bypasses all other isolation (jailer, iptables, seccomp). Google's kvmCTF program offers $250K for a full escape, indicating it's rare but not impossible. Keep the host kernel patched aggressively.
- **Spectre-PHT remains exploitable** across Firecracker VMs even with AWS-recommended mitigations (arXiv:2311.15999). A Medusa "cache indexing / block write" variant is uniquely exploitable inside Firecracker VMs (works in the VM but not on bare metal). The `nosmt` host boot parameter mitigates but does not fully resolve.
- **Virtio device emulation** is the primary code-level attack surface. Firecracker's Rust codebase and minimal device model (5 devices) make exploitation difficult but not impossible — CVE-2019-18960 was a vsock buffer overflow allowing host heap read/write. The jailer now contains blast radius.

## Recommended Host Configuration

These are operational changes on the host OS, not lobsterd code changes.

- **Disable SMT** — Add `nosmt` to the host kernel boot parameters. Required for meaningful side-channel protection in multi-tenant deployments.
- **Disable KSM** — `echo 0 > /sys/kernel/mm/ksm/run`. Kernel Samepage Merging enables page deduplication side-channel attacks.
- **Constrain kvm-pit threads** — The jailer creates cgroups for the Firecracker process, but `kvm-pit` kernel threads spawned by KVM live outside them. These can be abused to consume ~68% of host CPU (USENIX Security 2023). Move them into per-VM cgroups and lower `min_timer_period_us`.
- **Tune nf_conntrack** — Even with network rate limiting, a tenant can open many low-bandwidth connections to exhaust the host conntrack table, causing packet drops for all VMs. Set `sysctl net.netfilter.nf_conntrack_max` appropriately and consider per-source `connlimit` iptables rules.
- **Pin Firecracker version** — CVE-2026-1386 (jailer symlink arbitrary file overwrite) affected <= v1.13.1. Ensure v1.13.2+ or v1.14.1+.
- **Use ECC RAM and DDR4 with TRR** — Rowhammer protection for physical hosts.

## Future Code Improvements

Nice-to-have hardening that could be added to lobsterd itself.

- **Encrypt snapshots** — The `snap` command copies overlay files containing `/root/.openclaw/openclaw.json` (with API keys) in cleartext. Encrypt at rest or wipe sensitive pages before snapshot.
- **Audit logging** — No logging of sensitive operations (spawn, evict, secret injection). Add structured logs for forensic analysis if a tenant is compromised.
- **Caddy admin API access control** — Caddy listens on `localhost:2019`. Any host process can reconfigure all tenant routes. Consider binding to a Unix socket with restricted permissions.
- **Caddy-to-guest TLS** — Caddy reverse-proxies to `guest_ip:9000` over plain HTTP. Acceptable on a point-to-point /30 link but would matter on a shared network.
- **Agent token exposure** — The per-tenant `agent_token` is passed via `/proc/cmdline` inside the guest, readable by any process in the VM. Acceptable for single-user VMs but would be a concern for multi-user guests.
- **Chroot filesystem isolation** — The jailer chroot base is on the same filesystem as all tenant overlays (required for hard links). A VMM escape that also bypasses the chroot could traverse to other tenants' data. Consider separate filesystems per tenant for defense in depth.

## References

- [Firecracker Production Host Setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)
- [Microarchitectural Security of Firecracker VMM (arXiv:2311.15999)](https://arxiv.org/abs/2311.15999)
- [Attacks are Forwarded — USENIX Security 2023](https://www.usenix.org/conference/usenixsecurity23/presentation/xiao-jietao)
- [Attacking Firecracker — Grapl Security](https://chomp.ie/Blog+Posts/Attacking+Firecracker+-+AWS'+microVM+Monitor+Written+in+Rust)
- [Google kvmCTF Bounty Program](https://security.googleblog.com/2024/06/virtual-escape-real-reward-introducing.html)
