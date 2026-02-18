import { chmodSync } from "node:fs";
import { ResultAsync } from "neverthrow";
import type { LobsterError } from "../types/index.js";
import { exec, execUnchecked } from "./exec.js";

export function generateWatchUnit(bunPath: string, entryPoint: string): string {
  return `[Unit]
Description=lobsterd watchdog — monitors and auto-repairs tenant VMs
After=network.target caddy.service
Wants=caddy.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${bunPath} run ${entryPoint} watch --daemon
Restart=on-failure
RestartSec=5
WorkingDirectory=/var/lib/lobsterd
StandardOutput=journal
StandardError=journal
SyslogIdentifier=lobsterd-watch

[Install]
WantedBy=multi-user.target
`;
}

export function installService(
  name: string,
  content: string,
): ResultAsync<void, LobsterError> {
  const unitPath = `/etc/systemd/system/${name}.service`;
  return ResultAsync.fromPromise(
    (async () => {
      await Bun.write(unitPath, content);
      chmodSync(unitPath, 0o644);
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: `Failed to write systemd unit ${unitPath}: ${e instanceof Error ? e.message : String(e)}`,
      cause: e,
    }),
  ).andThen(() => exec(["systemctl", "daemon-reload"]).map(() => undefined));
}

export function enableAndStartService(
  name: string,
): ResultAsync<void, LobsterError> {
  return exec(["systemctl", "enable", name])
    .andThen(() => exec(["systemctl", "restart", name]))
    .map(() => undefined);
}

export function stopAndRemoveService(
  name: string,
): ResultAsync<void, LobsterError> {
  const unitPath = `/etc/systemd/system/${name}.service`;
  return execUnchecked(["systemctl", "stop", name])
    .andThen(() => execUnchecked(["systemctl", "disable", name]))
    .andThen(() =>
      ResultAsync.fromPromise(
        (async () => {
          const { unlinkSync } = await import("node:fs");
          try {
            unlinkSync(unitPath);
          } catch {
            /* unit file may not exist */
          }
        })(),
        (e) => ({
          code: "EXEC_FAILED" as const,
          message: `Failed to remove ${unitPath}: ${e instanceof Error ? e.message : String(e)}`,
          cause: e,
        }),
      ),
    )
    .andThen(() =>
      execUnchecked(["systemctl", "daemon-reload"]).map(() => undefined),
    );
}
