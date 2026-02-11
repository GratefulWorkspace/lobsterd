import { okAsync, type ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";
import { exec, execUnchecked } from "./exec.js";

const CHAIN_INPUT = "LOBSTER-INPUT";
const CHAIN_FORWARD = "LOBSTER-FORWARD";
const GUEST_GATEWAY_PORT = 9000;
const CONNLIMIT_PER_TENANT = 1024;

/** Ensure our custom chains exist and are jumped to from the built-in chains. */
export function ensureChains(): ResultAsync<void, LobsterError> {
  // Create chains (ignore error if already exists)
  return (
    execUnchecked(["iptables", "-N", CHAIN_INPUT])
      .andThen(() => execUnchecked(["iptables", "-N", CHAIN_FORWARD]))
      // Insert jumps at position 1 so they take priority over anything else.
      // First check if the jump already exists to avoid duplicates.
      .andThen(() =>
        execUnchecked(["iptables", "-C", "INPUT", "-j", CHAIN_INPUT]),
      )
      .andThen((r) => {
        if (r.exitCode !== 0) {
          return exec(["iptables", "-I", "INPUT", "1", "-j", CHAIN_INPUT]).map(
            () => undefined,
          );
        }
        return okAsync(undefined);
      })
      .andThen(() =>
        execUnchecked(["iptables", "-C", "FORWARD", "-j", CHAIN_FORWARD]),
      )
      .andThen((r) => {
        if (r.exitCode !== 0) {
          return exec([
            "iptables",
            "-I",
            "FORWARD",
            "1",
            "-j",
            CHAIN_FORWARD,
          ]).map(() => undefined);
        }
        return okAsync(undefined);
      })
      .map(() => undefined)
  );
}

export function createTap(
  name: string,
  hostIp: string,
  _guestIp: string,
): ResultAsync<void, LobsterError> {
  const cidr = `${hostIp}/30`;
  return (
    exec(["ip", "tuntap", "add", "dev", name, "mode", "tap"])
      .andThen(() => exec(["ip", "addr", "add", cidr, "dev", name]))
      .andThen(() => exec(["ip", "link", "set", name, "up"]))
      // Disable IPv6 on the TAP device to prevent guest IPv6 escape
      .andThen(() =>
        exec(["sysctl", "-w", `net.ipv6.conf.${name}.disable_ipv6=1`]),
      )
      .map(() => undefined)
      .mapErr((e) => ({
        ...e,
        code: "TAP_CREATE_FAILED" as const,
        message: `Failed to create TAP ${name}: ${e.message}`,
      }))
  );
}

export function deleteTap(name: string): ResultAsync<void, LobsterError> {
  return exec(["ip", "link", "delete", name])
    .map(() => undefined)
    .orElse(() => okAsync(undefined));
}

export function addNat(
  tapName: string,
  guestIp: string,
  gatewayPort: number,
): ResultAsync<void, LobsterError> {
  return exec([
    "iptables",
    "-t",
    "nat",
    "-A",
    "PREROUTING",
    "-p",
    "tcp",
    "--dport",
    String(gatewayPort),
    "!",
    "-s",
    "10.0.0.0/8",
    "-j",
    "DNAT",
    "--to-destination",
    `${guestIp}:${GUEST_GATEWAY_PORT}`,
    "-m",
    "comment",
    "--comment",
    `lobster:${tapName}`,
  ])
    .andThen(() =>
      exec([
        "iptables",
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-o",
        tapName,
        "-j",
        "MASQUERADE",
        "-m",
        "comment",
        "--comment",
        `lobster:${tapName}`,
      ]),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-s",
        `${guestIp}/32`,
        "!",
        "-o",
        tapName,
        "-j",
        "MASQUERADE",
        "-m",
        "comment",
        "--comment",
        `lobster:${tapName}:outbound`,
      ]),
    )
    .map(() => undefined);
}

export function removeNat(
  tapName: string,
  guestIp: string,
  gatewayPort: number,
): ResultAsync<void, LobsterError> {
  return exec([
    "iptables",
    "-t",
    "nat",
    "-D",
    "PREROUTING",
    "-p",
    "tcp",
    "--dport",
    String(gatewayPort),
    "!",
    "-s",
    "10.0.0.0/8",
    "-j",
    "DNAT",
    "--to-destination",
    `${guestIp}:${GUEST_GATEWAY_PORT}`,
    "-m",
    "comment",
    "--comment",
    `lobster:${tapName}`,
  ])
    .orElse(() => okAsync({ exitCode: 0, stdout: "", stderr: "" }))
    .andThen(() =>
      exec([
        "iptables",
        "-t",
        "nat",
        "-D",
        "POSTROUTING",
        "-o",
        tapName,
        "-j",
        "MASQUERADE",
        "-m",
        "comment",
        "--comment",
        `lobster:${tapName}`,
      ]).orElse(() => okAsync({ exitCode: 0, stdout: "", stderr: "" })),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-t",
        "nat",
        "-D",
        "POSTROUTING",
        "-s",
        `${guestIp}/32`,
        "!",
        "-o",
        tapName,
        "-j",
        "MASQUERADE",
        "-m",
        "comment",
        "--comment",
        `lobster:${tapName}:outbound`,
      ]).orElse(() => okAsync({ exitCode: 0, stdout: "", stderr: "" })),
    )
    .map(() => undefined);
}

/** Add INPUT and FORWARD rules to isolate a guest from the host and other tenants. */
export function addIsolationRules(
  tapName: string,
): ResultAsync<void, LobsterError> {
  const comment = (suffix: string) => [
    "-m",
    "comment",
    "--comment",
    `lobster:${tapName}:${suffix}`,
  ];

  // INPUT: allow established/related responses back to host (for host-initiated connections)
  return (
    exec([
      "iptables",
      "-A",
      CHAIN_INPUT,
      "-i",
      tapName,
      "-m",
      "conntrack",
      "--ctstate",
      "ESTABLISHED,RELATED",
      "-j",
      "ACCEPT",
      ...comment("host-return"),
    ])
      // INPUT: block all guest-initiated connections to the host
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_INPUT,
          "-i",
          tapName,
          "-j",
          "DROP",
          ...comment("block-host"),
        ]),
      )
      // FORWARD: allow established/related responses back to guest
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-o",
          tapName,
          "-m",
          "conntrack",
          "--ctstate",
          "ESTABLISHED,RELATED",
          "-j",
          "ACCEPT",
          ...comment("return"),
        ]),
      )
      // FORWARD: allow new DNAT'd inbound connections to guest gateway
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-o",
          tapName,
          "-p",
          "tcp",
          "--dport",
          String(GUEST_GATEWAY_PORT),
          "-m",
          "conntrack",
          "--ctstate",
          "NEW",
          "-j",
          "ACCEPT",
          ...comment("gateway-in"),
        ]),
      )
      // FORWARD: block guest from reaching RFC1918 private networks
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-d",
          "10.0.0.0/8",
          "-j",
          "DROP",
          ...comment("block-rfc1918"),
        ]),
      )
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-d",
          "172.16.0.0/12",
          "-j",
          "DROP",
          ...comment("block-rfc1918"),
        ]),
      )
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-d",
          "192.168.0.0/16",
          "-j",
          "DROP",
          ...comment("block-rfc1918"),
        ]),
      )
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-d",
          "169.254.0.0/16",
          "-j",
          "DROP",
          ...comment("block-link-local"),
        ]),
      )
      // FORWARD: per-tenant connection limit to prevent conntrack exhaustion
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-m",
          "connlimit",
          "--connlimit-above",
          String(CONNLIMIT_PER_TENANT),
          "--connlimit-saddr",
          "-j",
          "DROP",
          ...comment("connlimit"),
        ]),
      )
      // FORWARD: allow guest outbound to internet
      .andThen(() =>
        exec([
          "iptables",
          "-A",
          CHAIN_FORWARD,
          "-i",
          tapName,
          "-j",
          "ACCEPT",
          ...comment("outbound"),
        ]),
      )
      .map(() => undefined)
  );
}

/** Remove INPUT and FORWARD isolation rules for a tenant. */
export function removeIsolationRules(
  tapName: string,
): ResultAsync<void, LobsterError> {
  const comment = (suffix: string) => [
    "-m",
    "comment",
    "--comment",
    `lobster:${tapName}:${suffix}`,
  ];
  const ignore = () =>
    okAsync({ exitCode: 0, stdout: "", stderr: "" } as const);

  return exec([
    "iptables",
    "-D",
    CHAIN_INPUT,
    "-i",
    tapName,
    "-m",
    "conntrack",
    "--ctstate",
    "ESTABLISHED,RELATED",
    "-j",
    "ACCEPT",
    ...comment("host-return"),
  ])
    .orElse(ignore)
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_INPUT,
        "-i",
        tapName,
        "-j",
        "DROP",
        ...comment("block-host"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-o",
        tapName,
        "-m",
        "conntrack",
        "--ctstate",
        "ESTABLISHED,RELATED",
        "-j",
        "ACCEPT",
        ...comment("return"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-o",
        tapName,
        "-p",
        "tcp",
        "--dport",
        String(GUEST_GATEWAY_PORT),
        "-m",
        "conntrack",
        "--ctstate",
        "NEW",
        "-j",
        "ACCEPT",
        ...comment("gateway-in"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-d",
        "10.0.0.0/8",
        "-j",
        "DROP",
        ...comment("block-rfc1918"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-d",
        "172.16.0.0/12",
        "-j",
        "DROP",
        ...comment("block-rfc1918"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-d",
        "192.168.0.0/16",
        "-j",
        "DROP",
        ...comment("block-rfc1918"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-d",
        "169.254.0.0/16",
        "-j",
        "DROP",
        ...comment("block-link-local"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-m",
        "connlimit",
        "--connlimit-above",
        String(CONNLIMIT_PER_TENANT),
        "--connlimit-saddr",
        "-j",
        "DROP",
        ...comment("connlimit"),
      ]).orElse(ignore),
    )
    .andThen(() =>
      exec([
        "iptables",
        "-D",
        CHAIN_FORWARD,
        "-i",
        tapName,
        "-j",
        "ACCEPT",
        ...comment("outbound"),
      ]).orElse(ignore),
    )
    .map(() => undefined);
}

export function enableIpForwarding(): ResultAsync<void, LobsterError> {
  return exec(["sysctl", "-w", "net.ipv4.ip_forward=1"]).map(() => undefined);
}
