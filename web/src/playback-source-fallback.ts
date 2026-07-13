import type { PlaybackSourceManifest } from "@bili-syncplay/protocol";

const MANIFEST_REFRESH_WINDOW_MS = 60_000;
const METADATA_TIMEOUT_MS = 10_000;
const STALL_TIMEOUT_MS = 15_000;

export type PlaybackFallbackDecision =
  | { kind: "refresh" }
  | { kind: "next"; variantIndex: number }
  | { kind: "exhausted" };

export function decidePlaybackFallback(args: {
  manifest: PlaybackSourceManifest;
  activeVariantIndex: number;
  now: number;
}): PlaybackFallbackDecision {
  if (args.manifest.expiresAt - args.now <= MANIFEST_REFRESH_WINDOW_MS) {
    return { kind: "refresh" };
  }
  const nextIndex = args.activeVariantIndex + 1;
  return nextIndex < args.manifest.variants.length
    ? { kind: "next", variantIndex: nextIndex }
    : { kind: "exhausted" };
}

export class MediaFallbackTimer {
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFallback: (
      reason: "metadata-timeout" | "stalled",
    ) => void,
  ) {}

  armMetadataTimeout(): void {
    this.clearMetadataTimer();
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = null;
      this.onFallback("metadata-timeout");
    }, METADATA_TIMEOUT_MS);
  }

  markMetadataLoaded(): void {
    this.clearMetadataTimer();
  }

  armStallTimeout(): void {
    if (this.stallTimer) {
      return;
    }
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      this.onFallback("stalled");
    }, STALL_TIMEOUT_MS);
  }

  markPlayable(): void {
    this.clearStallTimer();
  }

  dispose(): void {
    this.clearMetadataTimer();
    this.clearStallTimer();
  }

  private clearMetadataTimer(): void {
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}
