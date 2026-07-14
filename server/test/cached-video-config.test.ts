import assert from "node:assert/strict";
import test from "node:test";
import { loadCachedVideoConfig } from "../src/config/cached-video-config.js";

test("cached video config is disabled when no directory is configured", () => {
  assert.deepEqual(loadCachedVideoConfig({}), {
    directory: undefined,
    scanIntervalMs: 30_000,
  });
});

test("cached video config trims the directory and parses the scan interval", () => {
  assert.deepEqual(
    loadCachedVideoConfig({
      CACHED_VIDEO_DIR: "  /opt/bilisync/media  ",
      CACHED_VIDEO_SCAN_INTERVAL_MS: "45000",
    }),
    {
      directory: "/opt/bilisync/media",
      scanIntervalMs: 45_000,
    },
  );
});

test("cached video config rejects unsafe scan intervals", () => {
  assert.throws(
    () => loadCachedVideoConfig({ CACHED_VIDEO_SCAN_INTERVAL_MS: "999" }),
    /between 5000 and 3600000/,
  );
  assert.throws(
    () => loadCachedVideoConfig({ CACHED_VIDEO_SCAN_INTERVAL_MS: "3600001" }),
    /between 5000 and 3600000/,
  );
});
