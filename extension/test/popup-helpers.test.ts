import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, parseInviteValue } from "../src/popup/helpers";

test("escapeHtml escapes html-sensitive characters", () => {
  assert.equal(
    escapeHtml(`a&b<c>"d"'e`),
    "a&amp;b&lt;c&gt;&quot;d&quot;&#39;e",
  );
});

test("escapeHtml tolerates undefined and null values", () => {
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(null), "");
});

test("escapeHtml coerces non-string values safely", () => {
  assert.equal(escapeHtml(123), "123");
  assert.equal(escapeHtml(false), "false");
});

test("parseInviteValue extracts roomCode and joinToken from an invite string", () => {
  assert.deepEqual(parseInviteValue("abc123:join-token-123456"), {
    roomCode: "ABC123",
    joinToken: "join-token-123456",
  });
});

test("parseInviteValue returns null for malformed input", () => {
  assert.equal(parseInviteValue("ABC123"), null);
  assert.equal(parseInviteValue(""), null);
  assert.equal(parseInviteValue("AB12:join-token-123456"), null);
  assert.equal(parseInviteValue("ABC123:short-token"), null);
});
