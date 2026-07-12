export type VoiceCredential = {
  sdkAppId: number;
  userId: string;
  userSig: string;
  privateMapKey: string;
  roomId: string;
  expiresInSeconds: number;
};

export type VoiceSessionStatus = "idle" | "joining" | "joined" | "error";

export type VoiceSessionState = {
  status: VoiceSessionStatus;
  muted: boolean;
  error: string | null;
};

type VoiceAdapterEvents = {
  "remote-audio-available": (userId: string) => void | Promise<void>;
  "audio-volume": (volumes: Array<{ userId: string; volume: number }>) => void;
};

export interface TrtcVoiceAdapter {
  on<K extends keyof VoiceAdapterEvents>(
    event: K,
    listener: VoiceAdapterEvents[K],
  ): void;
  off(event: keyof VoiceAdapterEvents): void;
  enterRoom(credential: VoiceCredential): Promise<void>;
  exitRoom(): Promise<void>;
  startLocalAudio(): Promise<void>;
  stopLocalAudio(): Promise<void>;
  startRemoteAudio(userId: string): Promise<void>;
  setRemoteAudioVolume(userId: string, volume: number): void;
  enableAudioVolumeEvaluation(interval: number): void;
  destroy(): void;
}

export type VoiceSessionCallbacks = {
  onStateChange?: (state: VoiceSessionState) => void;
  onRemoteVolume?: (userId: string, volume: number) => void;
};

export class VoiceSessionController {
  private state: VoiceSessionState = {
    status: "idle",
    muted: false,
    error: null,
  };
  private left = false;

  constructor(
    private readonly adapter: TrtcVoiceAdapter,
    private readonly callbacks: VoiceSessionCallbacks = {},
  ) {
    this.adapter.on("remote-audio-available", async (userId) => {
      await this.adapter.startRemoteAudio(userId);
    });
    this.adapter.on("audio-volume", (volumes) => {
      for (const item of volumes) {
        this.callbacks.onRemoteVolume?.(item.userId, item.volume);
      }
    });
  }

  getState(): VoiceSessionState {
    return { ...this.state };
  }

  async join(credential: VoiceCredential): Promise<void> {
    this.left = false;
    this.updateState({ status: "joining", muted: false, error: null });
    try {
      await this.adapter.enterRoom(credential);
      this.adapter.enableAudioVolumeEvaluation(300);
      await this.adapter.startLocalAudio();
      this.updateState({ status: "joined", muted: false, error: null });
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : "语音加入失败";
      this.updateState({ status: "error", muted: true, error });
      throw reason;
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    if (this.state.status !== "joined" || this.state.muted === muted) {
      return;
    }
    if (muted) {
      await this.adapter.stopLocalAudio();
    } else {
      await this.adapter.startLocalAudio();
    }
    this.updateState({ ...this.state, muted });
  }

  setRemoteVolume(userId: string, volume: number): void {
    this.adapter.setRemoteAudioVolume(
      userId,
      Math.max(0, Math.min(100, Math.round(volume))),
    );
  }

  async leave(): Promise<void> {
    if (this.left || this.state.status === "idle") {
      return;
    }
    this.left = true;
    try {
      await this.adapter.stopLocalAudio();
      await this.adapter.exitRoom();
    } finally {
      this.adapter.off("remote-audio-available");
      this.adapter.off("audio-volume");
      this.adapter.destroy();
      this.updateState({ status: "idle", muted: false, error: null });
    }
  }

  private updateState(state: VoiceSessionState): void {
    this.state = state;
    this.callbacks.onStateChange?.(this.getState());
  }
}
