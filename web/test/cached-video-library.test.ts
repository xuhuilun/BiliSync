import assert from "node:assert/strict";
import test from "node:test";
import {
  createCachedVideoPlaybackUrl,
  getInitialWorkspaceView,
  readCachedVideoListResponse,
  shouldResolvePendingCachedVideo,
} from "../src/cached-video-library.js";

const video = {
  id: "cv_abc123",
  title: "Movie",
  streamUrl: "/api/web/cached-videos/cv_abc123/video.mp4",
  size: 2048,
  updatedAt: 1_784_000_000_000,
  status: "ready" as const,
};

test("cached video list parser accepts the public API contract", () => {
  assert.deepEqual(
    readCachedVideoListResponse({
      ok: true,
      data: { enabled: true, videos: [video] },
    }),
    { enabled: true, videos: [video] },
  );
});

test("cached video list parser rejects malformed and external stream urls", () => {
  assert.throws(
    () =>
      readCachedVideoListResponse({
        ok: true,
        data: {
          enabled: true,
          videos: [{ ...video, streamUrl: "https://example.com/movie.mp4" }],
        },
      }),
    /invalid cached video response/i,
  );
  assert.throws(
    () => readCachedVideoListResponse({ ok: false }),
    /invalid cached video response/i,
  );
});

test("cached video playback url is resolved against the current site", () => {
  assert.equal(
    createCachedVideoPlaybackUrl(video, "https://bilisync.top"),
    "https://bilisync.top/api/web/cached-videos/cv_abc123/video.mp4",
  );
});

test("pending cached video waits for credentials from a newly created room", () => {
  assert.equal(shouldResolvePendingCachedVideo(null, null), false);
  assert.equal(
    shouldResolvePendingCachedVideo("old-token", {
      memberToken: "old-token",
    }),
    false,
  );
  assert.equal(
    shouldResolvePendingCachedVideo("old-token", {
      memberToken: "new-token",
    }),
    true,
  );
  assert.equal(
    shouldResolvePendingCachedVideo(null, { memberToken: "new-token" }),
    true,
  );
});

test("cached video library is the default unless the page contains a room invite", () => {
  assert.equal(getInitialWorkspaceView("", ""), "library");
  assert.equal(getInitialWorkspaceView("ABC123", "join-token"), "player");
  assert.equal(getInitialWorkspaceView("ABC123", ""), "library");
});
