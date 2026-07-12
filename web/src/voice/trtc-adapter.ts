import type { TrtcVoiceAdapter, VoiceCredential } from "./voice-session.js";

export async function createTrtcVoiceAdapter(): Promise<TrtcVoiceAdapter> {
  const { default: TRTC } = await import("trtc-sdk-v5");
  const client = TRTC.create();
  const listeners = new Map<string, (...args: unknown[]) => void>();

  return {
    on(event, listener) {
      const wrapped = (payload: unknown) => {
        if (event === "remote-audio-available") {
          const userId = (payload as { userId: string }).userId;
          void (listener as (userId: string) => void | Promise<void>)(userId);
          return;
        }
        const result = (
          payload as {
            result: Array<{ userId: string; volume: number }>;
          }
        ).result;
        (listener as (items: typeof result) => void)(result);
      };
      listeners.set(event, wrapped);
      client.on(event, wrapped as never);
    },
    off(event) {
      const listener = listeners.get(event);
      if (listener) {
        client.off(event, listener as never);
        listeners.delete(event);
      }
    },
    enterRoom(credential: VoiceCredential) {
      return client.enterRoom({
        sdkAppId: credential.sdkAppId,
        userId: credential.userId,
        userSig: credential.userSig,
        privateMapKey: credential.privateMapKey,
        strRoomId: credential.roomId,
        scene: TRTC.TYPE.SCENE_RTC,
        autoReceiveAudio: true,
      });
    },
    exitRoom: () => client.exitRoom(),
    startLocalAudio: () =>
      client.startLocalAudio({
        option: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
    stopLocalAudio: () => client.stopLocalAudio(),
    startRemoteAudio: (userId) => client.muteRemoteAudio(userId, false),
    setRemoteAudioVolume: (userId, volume) =>
      client.setRemoteAudioVolume(userId, volume),
    enableAudioVolumeEvaluation: (interval) =>
      client.enableAudioVolumeEvaluation(interval),
    destroy: () => client.destroy(),
  };
}
