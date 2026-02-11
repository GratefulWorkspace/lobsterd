import { err, ok, ResultAsync } from "neverthrow";
import type { ExecResult, LobsterError } from "../types/index.js";

export interface ExecOpts {
  asUser?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export function exec(
  args: string[],
  opts: ExecOpts = {},
): ResultAsync<ExecResult, LobsterError> {
  const timeout = opts.timeout ?? 30_000;

  let finalArgs = args;
  const finalEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };

  if (opts.asUser) {
    // Wrap with sudo -u <user> -- and pass env vars
    const envPairs = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : [];
    finalArgs = [
      "sudo",
      "-u",
      opts.asUser,
      ...envPairs.map((e) => `--preserve-env=${e.split("=")[0]}`),
      "--",
      ...args,
    ];
    if (opts.env) {
      Object.assign(finalEnv, opts.env);
    }
  }

  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn(finalArgs, {
        env: finalEnv,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      return { exitCode, stdout, stderr };
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: `Failed to execute: ${finalArgs.join(" ")}`,
      cause: e,
    }),
  ).andThen((result) => {
    if (result.exitCode !== 0) {
      return err({
        code: "EXEC_FAILED" as const,
        message:
          `Command failed (exit ${result.exitCode}): ${finalArgs.join(" ")}\n${result.stderr}`.trim(),
        cause: result,
      });
    }
    return ok(result);
  });
}

/** Like exec but doesn't fail on non-zero exit — just returns the result */
export function execUnchecked(
  args: string[],
  opts: ExecOpts = {},
): ResultAsync<ExecResult, LobsterError> {
  const timeout = opts.timeout ?? 30_000;

  let finalArgs = args;
  const finalEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
  };

  if (opts.asUser) {
    const envPairs = opts.env
      ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`)
      : [];
    finalArgs = [
      "sudo",
      "-u",
      opts.asUser,
      ...envPairs.map((e) => `--preserve-env=${e.split("=")[0]}`),
      "--",
      ...args,
    ];
    if (opts.env) {
      Object.assign(finalEnv, opts.env);
    }
  }

  return ResultAsync.fromPromise(
    (async () => {
      const proc = Bun.spawn(finalArgs, {
        env: finalEnv,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      return { exitCode, stdout, stderr };
    })(),
    (e) => ({
      code: "EXEC_FAILED" as const,
      message: `Failed to execute: ${finalArgs.join(" ")}`,
      cause: e,
    }),
  );
}

/** Get the UID for a username */
export function getUid(username: string): ResultAsync<number, LobsterError> {
  return exec(["id", "-u", username]).map((r) => parseInt(r.stdout.trim(), 10));
}
