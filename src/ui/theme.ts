import type { HealthStatus, WatchState } from "../types/index.js";

export const STATUS_COLORS: Record<HealthStatus, string> = {
  ok: "green",
  degraded: "yellow",
  failed: "red",
};

export const WATCH_STATE_COLORS: Record<WatchState, string> = {
  UNKNOWN: "gray",
  HEALTHY: "green",
  DEGRADED: "yellow",
  FAILED: "red",
  RECOVERING: "cyan",
  SUSPENDED: "blue",
};

export const STATUS_SYMBOLS: Record<HealthStatus, string> = {
  ok: "●",
  degraded: "◐",
  failed: "○",
};

export const WATCH_STATE_SYMBOLS: Record<WatchState, string> = {
  UNKNOWN: "?",
  HEALTHY: "●",
  DEGRADED: "◐",
  FAILED: "✗",
  RECOVERING: "↻",
  SUSPENDED: "⏸",
};

export const LOBSTER = "🦞";
