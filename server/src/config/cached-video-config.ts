import { parseIntegerEnv, readTrimmedEnv, type EnvSource } from "./env.js";

const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const MIN_SCAN_INTERVAL_MS = 5_000;
const MAX_SCAN_INTERVAL_MS = 3_600_000;

export type CachedVideoConfig = {
  directory: string | undefined;
  scanIntervalMs: number;
};

export function loadCachedVideoConfig(
  env: EnvSource = process.env,
): CachedVideoConfig {
  const scanIntervalMs = parseIntegerEnv(
    env,
    "CACHED_VIDEO_SCAN_INTERVAL_MS",
    DEFAULT_SCAN_INTERVAL_MS,
  );
  if (
    scanIntervalMs < MIN_SCAN_INTERVAL_MS ||
    scanIntervalMs > MAX_SCAN_INTERVAL_MS
  ) {
    throw new Error(
      "Environment variable CACHED_VIDEO_SCAN_INTERVAL_MS must be between 5000 and 3600000.",
    );
  }

  return {
    directory: readTrimmedEnv(env, "CACHED_VIDEO_DIR"),
    scanIntervalMs,
  };
}
