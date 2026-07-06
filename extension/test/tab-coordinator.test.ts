import assert from "node:assert/strict";
import test from "node:test";
import {
  decideSharedPlaybackTab,
  rememberSharedSource,
} from "../src/background/tab-coordinator";

test("shared source tab remembers the current tab when present", () => {
  assert.deepEqual(
    rememberSharedSource({
      currentSharedTabId: null,
      tabId: 12,
      url: "https://www.bilibili.com/video/BV1?p=1",
    }),
    {
      sharedTabId: 12,
      lastOpenedSharedUrl: "https://www.bilibili.com/video/BV1?p=1",
    },
  );
});

test("first matching playback tab becomes the shared tab", () => {
  assert.deepEqual(
    decideSharedPlaybackTab({
      tabId: 20,
      sharedTabId: null,
      normalizedRoomUrl: "https://www.bilibili.com/video/BV1?p=1",
      normalizedPayloadUrl: "https://www.bilibili.com/video/BV1?p=1",
    }),
    {
      accepted: true,
      nextSharedTabId: 20,
      reason: "accepted-first",
    },
  );
});

test("existing shared tab is rejected when its url no longer matches the room", () => {
  assert.deepEqual(
    decideSharedPlaybackTab({
      tabId: 20,
      sharedTabId: 20,
      normalizedRoomUrl: "https://www.bilibili.com/video/BV1?p=1",
      normalizedPayloadUrl: "https://www.bilibili.com/video/BV2?p=1",
    }),
    {
      accepted: false,
      nextSharedTabId: 20,
      reason: "room-mismatch",
    },
  );
});
