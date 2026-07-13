import assert from "node:assert/strict";
import test from "node:test";
import {
  isClientMessage,
  isPlaybackSourceManifest,
  isServerMessage,
} from "../src/index.js";

const MEMBER_TOKEN = "member-token-1234567890";

test("client message guard accepts direct HLS shared videos", () => {
  assert.equal(
    isClientMessage({
      type: "video:share",
      payload: {
        memberToken: MEMBER_TOKEN,
        video: {
          videoId: "direct:demo-stream",
          url: "https://media.example.com/watch/demo-stream.m3u8",
          title: "Demo stream",
          sourceProvider: "direct",
          sourceRef: "https://media.example.com/watch/demo-stream.m3u8",
          posterUrl: "https://media.example.com/posters/demo-stream.jpg",
          duration: 120,
        },
      },
    }),
    true,
  );
});

test("server message guard accepts room state with direct shared videos", () => {
  assert.equal(
    isServerMessage({
      type: "room:state",
      payload: {
        roomCode: "ABC123",
        sharedVideo: {
          videoId: "direct:demo-video",
          url: "https://media.example.com/video/demo.mp4",
          title: "Demo video",
          sourceProvider: "direct",
          sourceRef: "https://media.example.com/video/demo.mp4",
        },
        playback: null,
        members: [],
      },
    }),
    true,
  );
});

test("playback source manifest guard accepts hls and mp4 variants", () => {
  assert.equal(
    isPlaybackSourceManifest({
      videoId: "direct:demo-video",
      title: "Demo video",
      expiresAt: Date.now() + 60_000,
      variants: [
        {
          kind: "hls",
          url: "https://media.example.com/video/demo.m3u8",
          mimeType: "application/vnd.apple.mpegurl",
          label: "Auto",
        },
        {
          kind: "mp4",
          url: "https://media.example.com/video/demo.mp4",
          mimeType: "video/mp4",
          label: "MP4",
        },
      ],
    }),
    true,
  );
});

test("playback source manifest guard accepts same-origin media proxy variants", () => {
  assert.equal(
    isPlaybackSourceManifest({
      videoId: "BV1xx411c7mD:456",
      title: "Movie Night",
      expiresAt: Date.now() + 60_000,
      variants: [
        {
          kind: "mp4",
          url: "/api/web/media/media-token-123456/video.mp4?roomCode=ABC123&memberToken=member-token-1234567890",
          mimeType: "video/mp4",
          label: "B站代理",
        },
      ],
    }),
    true,
  );
});

test("playback source manifest accepts long signed CDN urls", () => {
  const signedUrl = `https://upos.example.test/video.mp4?token=${"a".repeat(900)}`;
  assert.equal(
    isPlaybackSourceManifest({
      videoId: "BV1xx411c7mD:456",
      title: "Long movie",
      expiresAt: Date.now() + 60_000,
      variants: [
        {
          kind: "mp4",
          url: signedUrl,
          mimeType: "video/mp4",
          label: "B站 CDN",
        },
      ],
    }),
    true,
  );
});

test("playback source manifest guard rejects unsupported protocols", () => {
  assert.equal(
    isPlaybackSourceManifest({
      videoId: "direct:demo-video",
      title: "Demo video",
      expiresAt: Date.now() + 60_000,
      variants: [
        {
          kind: "mp4",
          url: "javascript:alert(1)",
          mimeType: "video/mp4",
        },
      ],
    }),
    false,
  );
});
