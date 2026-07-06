import assert from "node:assert/strict";
import test from "node:test";
import {
  getReconnectDelayMs,
  shouldReconnect,
} from "../src/background/socket-manager";

test("reconnect backoff grows and caps at ten seconds", () => {
  assert.equal(getReconnectDelayMs(1), 1000);
  assert.equal(getReconnectDelayMs(2), 2000);
  assert.equal(getReconnectDelayMs(5), 10000);
  assert.equal(getReconnectDelayMs(8), 10000);
});

test("reconnect scheduling requires an active room or pending create and stops at max attempts", () => {
  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: null,
      roomCode: "ROOM01",
      pendingCreateRoom: false,
      reconnectAttempt: 2,
      maxReconnectAttempts: 5,
    }),
    true,
  );

  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: null,
      roomCode: null,
      pendingCreateRoom: false,
      reconnectAttempt: 2,
      maxReconnectAttempts: 5,
    }),
    false,
  );

  assert.equal(
    shouldReconnect({
      connected: false,
      reconnectTimer: null,
      roomCode: "ROOM01",
      pendingCreateRoom: false,
      reconnectAttempt: 5,
      maxReconnectAttempts: 5,
    }),
    false,
  );
});
