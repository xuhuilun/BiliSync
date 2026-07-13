import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackSourceManifest } from "@bili-syncplay/protocol";
import {
  MediaFallbackTimer,
  decidePlaybackFallback,
  isServerProxyVariant,
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

test("identifies only same-origin server media proxy variants", () => {
  const origin = "https://sync.example";

  assert.equal(
    isServerProxyVariant("/api/web/media/token/video.mp4", origin),
    true,
  );
  assert.equal(
    isServerProxyVariant(
      "https://sync.example/api/web/media/token/video.mp4",
      origin,
    ),
    true,
  );
  assert.equal(
    isServerProxyVariant(
      "https://media.example/api/web/media/token/video.mp4",
      origin,
    ),
    false,
  );
  assert.equal(isServerProxyVariant("/api/web/manifest/token", origin), false);
  assert.equal(isServerProxyVariant("not a valid URL", "not an origin"), false);
});

test("direct metadata timeout fires after 10 seconds", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer({
    mode: "direct",
    onFallback: (reason) => reasons.push(reason),
  });

  timer.armMetadataTimeout();
  context.mock.timers.tick(9_999);
  assert.deepEqual(reasons, []);
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("proxy metadata timeout starts at 60 seconds", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(reason),
  });

  timer.armMetadataTimeout();
  context.mock.timers.tick(59_999);
  assert.deepEqual(reasons, []);
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("proxy buffer growth extends metadata wait but repeated progress does not", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  let now = 0;
  const timer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(reason),
    now: () => now,
  });
  const tick = (milliseconds: number) => {
    now += milliseconds;
    context.mock.timers.tick(milliseconds);
  };

  timer.armMetadataTimeout();
  tick(50_000);
  timer.markProgress(2);
  tick(20_000);
  timer.markProgress(2);
  tick(9_999);
  assert.deepEqual(reasons, []);
  tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("proxy progress without a finite buffered end does not extend metadata wait", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(reason),
  });

  timer.armMetadataTimeout();
  context.mock.timers.tick(50_000);
  timer.markProgress(Number.NaN);
  timer.markProgress(Number.POSITIVE_INFINITY);
  context.mock.timers.tick(10_000);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("proxy progress never extends metadata wait beyond 120 seconds", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  let now = 0;
  const timer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(reason),
    now: () => now,
  });
  const tick = (milliseconds: number) => {
    now += milliseconds;
    context.mock.timers.tick(milliseconds);
  };

  timer.armMetadataTimeout();
  tick(50_000);
  timer.markProgress(1);
  tick(25_000);
  timer.markProgress(2);
  tick(25_000);
  timer.markProgress(3);
  tick(19_999);
  assert.deepEqual(reasons, []);
  tick(1);
  assert.deepEqual(reasons, ["metadata-timeout"]);
});

test("stall timeout uses direct and proxy durations", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const directTimer = new MediaFallbackTimer({
    mode: "direct",
    onFallback: (reason) => reasons.push(`direct:${reason}`),
  });
  const proxyTimer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(`proxy:${reason}`),
  });

  directTimer.armStallTimeout();
  proxyTimer.armStallTimeout();
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, ["direct:stalled"]);
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, ["direct:stalled", "proxy:stalled"]);
});

test("proxy buffer growth resets an active stall timeout", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer({
    mode: "proxy",
    onFallback: (reason) => reasons.push(reason),
  });

  timer.armStallTimeout();
  context.mock.timers.tick(20_000);
  timer.markProgress(1);
  context.mock.timers.tick(29_999);
  assert.deepEqual(reasons, []);
  context.mock.timers.tick(1);
  assert.deepEqual(reasons, ["stalled"]);
});

test("initialization and playback timer APIs cancel their corresponding timers", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const reasons: string[] = [];
  const timer = new MediaFallbackTimer({
    mode: "direct",
    onFallback: (reason) => reasons.push(reason),
  });

  timer.armMetadataTimeout();
  timer.markMetadataLoaded();
  context.mock.timers.tick(10_000);
  assert.deepEqual(reasons, []);

  timer.armStallTimeout();
  timer.markPlayable();
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, []);

  timer.armMetadataTimeout();
  timer.armStallTimeout();
  timer.dispose();
  context.mock.timers.tick(15_000);
  assert.deepEqual(reasons, []);
});
