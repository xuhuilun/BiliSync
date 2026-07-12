import assert from "node:assert/strict";
import test from "node:test";
import { VoiceDuckingController } from "../src/voice/voice-ducking.js";

test("ducks video once while at least one remote user is speaking", () => {
  const gains: number[] = [];
  const controller = new VoiceDuckingController({
    onGainChange: (gain) => gains.push(gain),
    restoreDelayMs: 600,
  });

  controller.setSpeaking("alice", true);
  controller.setSpeaking("bob", true);
  controller.setSpeaking("alice", false);

  assert.deepEqual(gains, [0.4]);
  controller.dispose();
});

test("restores video after the last speaker stops", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gains: number[] = [];
  const controller = new VoiceDuckingController({
    onGainChange: (gain) => gains.push(gain),
    restoreDelayMs: 600,
  });

  controller.setSpeaking("alice", true);
  controller.setSpeaking("alice", false);
  context.mock.timers.tick(599);
  assert.deepEqual(gains, [0.4]);
  context.mock.timers.tick(1);
  assert.deepEqual(gains, [0.4, 1]);
  controller.dispose();
});

test("cancels pending restoration when speech resumes", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const gains: number[] = [];
  const controller = new VoiceDuckingController({
    onGainChange: (gain) => gains.push(gain),
    restoreDelayMs: 600,
  });

  controller.setSpeaking("alice", true);
  controller.setSpeaking("alice", false);
  context.mock.timers.tick(300);
  controller.setSpeaking("bob", true);
  context.mock.timers.tick(600);

  assert.deepEqual(gains, [0.4]);
  controller.dispose();
});
