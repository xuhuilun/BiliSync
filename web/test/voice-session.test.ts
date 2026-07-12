import assert from "node:assert/strict";
import test from "node:test";
import {
  VoiceSessionController,
  type TrtcVoiceAdapter,
  type VoiceCredential,
} from "../src/voice/voice-session.js";

const credential: VoiceCredential = {
  sdkAppId: 1400000001,
  userId: "web_user",
  userSig: "sig",
  privateMapKey: "room-bound-key",
  roomId: "ABC123",
  expiresInSeconds: 900,
};

function createAdapter() {
  const calls: string[] = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  const adapter: TrtcVoiceAdapter = {
    on(event, listener) {
      listeners.set(event, listener as (...args: never[]) => void);
    },
    off(event) {
      listeners.delete(event);
    },
    async enterRoom() {
      calls.push("enter");
    },
    async exitRoom() {
      calls.push("exit");
    },
    async startLocalAudio() {
      calls.push("start-local");
    },
    async stopLocalAudio() {
      calls.push("stop-local");
    },
    async startRemoteAudio(userId) {
      calls.push(`start-remote:${userId}`);
    },
    setRemoteAudioVolume(userId, volume) {
      calls.push(`volume:${userId}:${volume}`);
    },
    enableAudioVolumeEvaluation(interval) {
      calls.push(`evaluation:${interval}`);
    },
    destroy() {
      calls.push("destroy");
    },
  };
  return { adapter, calls, listeners };
}

test("joins TRTC and publishes microphone audio", async () => {
  const { adapter, calls } = createAdapter();
  const states: string[] = [];
  const controller = new VoiceSessionController(adapter, {
    onStateChange: (state) => states.push(state.status),
  });

  await controller.join(credential);

  assert.deepEqual(calls, ["enter", "evaluation:300", "start-local"]);
  assert.equal(controller.getState().status, "joined");
  assert.equal(controller.getState().muted, false);
  assert.deepEqual(states, ["joining", "joined"]);
});

test("mutes and unmutes by stopping and restarting local audio", async () => {
  const { adapter, calls } = createAdapter();
  const controller = new VoiceSessionController(adapter);
  await controller.join(credential);

  await controller.setMuted(true);
  await controller.setMuted(false);

  assert.deepEqual(calls.slice(-2), ["stop-local", "start-local"]);
  assert.equal(controller.getState().muted, false);
});

test("starts remote audio and reports speaking volume", async () => {
  const { adapter, calls, listeners } = createAdapter();
  const volumes: Array<{ userId: string; volume: number }> = [];
  const controller = new VoiceSessionController(adapter, {
    onRemoteVolume: (userId, volume) => volumes.push({ userId, volume }),
  });
  await controller.join(credential);

  await listeners.get("remote-audio-available")?.("alice" as never);
  listeners.get("audio-volume")?.([{ userId: "alice", volume: 36 }] as never);
  controller.setRemoteVolume("alice", 70);

  assert.ok(calls.includes("start-remote:alice"));
  assert.ok(calls.includes("volume:alice:70"));
  assert.deepEqual(volumes, [{ userId: "alice", volume: 36 }]);
});

test("leaves once and destroys all SDK resources", async () => {
  const { adapter, calls } = createAdapter();
  const controller = new VoiceSessionController(adapter);
  await controller.join(credential);

  await controller.leave();
  await controller.leave();

  assert.deepEqual(calls.slice(-3), ["stop-local", "exit", "destroy"]);
  assert.equal(controller.getState().status, "idle");
});
