export type VoiceDuckingOptions = {
  onGainChange: (gain: number) => void;
  duckedGain?: number;
  restoreDelayMs?: number;
};

export class VoiceDuckingController {
  private readonly speakingUsers = new Set<string>();
  private readonly onGainChange: (gain: number) => void;
  private readonly duckedGain: number;
  private readonly restoreDelayMs: number;
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;
  private ducked = false;

  constructor(options: VoiceDuckingOptions) {
    this.onGainChange = options.onGainChange;
    this.duckedGain = options.duckedGain ?? 0.4;
    this.restoreDelayMs = options.restoreDelayMs ?? 600;
  }

  setSpeaking(userId: string, speaking: boolean): void {
    if (speaking) {
      this.speakingUsers.add(userId);
      this.cancelRestore();
      if (!this.ducked) {
        this.ducked = true;
        this.onGainChange(this.duckedGain);
      }
      return;
    }

    this.speakingUsers.delete(userId);
    if (this.speakingUsers.size === 0 && this.ducked && !this.restoreTimer) {
      this.restoreTimer = setTimeout(() => {
        this.restoreTimer = null;
        if (this.speakingUsers.size === 0 && this.ducked) {
          this.ducked = false;
          this.onGainChange(1);
        }
      }, this.restoreDelayMs);
    }
  }

  dispose(): void {
    this.cancelRestore();
    this.speakingUsers.clear();
    if (this.ducked) {
      this.ducked = false;
      this.onGainChange(1);
    }
  }

  private cancelRestore(): void {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
  }
}
