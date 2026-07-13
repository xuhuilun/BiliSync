import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackSourceManifest } from "@bili-syncplay/protocol";
import {
  MediaFallbackTimer,
  decidePlaybackFallback,
} from "../src/playback-source-fallback.js";

const manifest: PlaybackSourceManifest = {
  videoId: "BV1xx411c7mD:456",
  title: "Movie",
  expiresAt: 1_000_000,
  variants: [
    {
      kind: "mp4",
      url: "https://primary.example/video.mp4",
      mimeType: "video/mp4",
    },
    {
      kind: "mp4",
      url: "/api/web/media/token/video.mp4",
      mimeType: "video/mp4",
    },
  ],
};

test("refreshes an expiring manifest before trying another candidate", () => {
  assert.deepEqual(
    decidePlaybackFallback({
      manifest,
      activeVariantIndex: 0,
      now: 950_000,
    }),
    { kind: "refresh" },
  );
});

test("advances once through candidates and then reports exhaustion", () => {
  assert.deepEqual(
    decidePlaybackFallback({
      manifest,
      activeVariantIndex: 0,
      now: 100_000,
    }),
    { kind: "next", variantIndex: 1 },
  );
  assert.deepEqual(
    decidePlaybackFallback({
      manifest,
      activeVariantIndex: 1,
      now: 100_000,
    }),
    { kind: "exhausted" },
  );
});

test("metadata and stall timers trigger one fallback and cancel on recovery", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer((reason) => reasons.push(reason));

  timer.armMetadataTimeout();
  context.mock.timers.tick(9_999);
  assert.deepEqual(reasons, []);
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);

  timer.armStallTimeout();
  context.mock.timers.tick(5_000);
  timer.markPlayable();
  context.mock.timers.tick(20_000);
  assert.deepEqual(reasons, ["metadata-timeout"]);

  timer.armStallTimeout();
  timer.armStallTimeout();
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, ["metadata-timeout", "stalled"]);
  timer.dispose();
});
