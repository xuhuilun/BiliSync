import assert from "node:assert/strict";
import test from "node:test";
import { createTrtcUserId } from "../src/voice/member-identity.js";

test("derives the same bounded TRTC user id as the server", async () => {
  const userId = await createTrtcUserId("member-123");

  assert.equal(userId, "web_6a55700bd590915f899c4eb03f29");
  assert.equal(userId.length, 32);
});
