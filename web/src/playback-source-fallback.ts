import type { PlaybackSourceManifest } from "@bili-syncplay/protocol";

const MANIFEST_REFRESH_WINDOW_MS = 60_000;
const DIRECT_METADATA_TIMEOUT_MS = 10_000;
const PROXY_METADATA_TIMEOUT_MS = 60_000;
const DIRECT_STALL_TIMEOUT_MS = 15_000;
const PROXY_STALL_TIMEOUT_MS = 30_000;
const PROXY_PROGRESS_EXTENSION_MS = 30_000;
const PROXY_METADATA_MAX_TIMEOUT_MS = 120_000;

export function isServerProxyVariant(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url, origin);
    return (
      parsed.origin === new URL(origin).origin &&
      parsed.pathname.startsWith("/api/web/media/")
    );
  } catch {
    return false;
  }
}

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
  private metadataDeadline: number | null = null;
  private metadataMaxDeadline: number | null = null;
  private lastBufferedEnd: number | null = null;
  private readonly mode: "direct" | "proxy";
  private readonly onFallback: (reason: "metadata-timeout" | "stalled") => void;
  private readonly now: () => number;

  constructor(options: {
    mode: "direct" | "proxy";
    onFallback: (reason: "metadata-timeout" | "stalled") => void;
    now?: () => number;
  }) {
    this.mode = options.mode;
    this.onFallback = options.onFallback;
    this.now = options.now ?? Date.now;
  }

  armMetadataTimeout(): void {
    this.clearMetadataTimer();
    const now = this.now();
    const timeout =
      this.mode === "proxy"
        ? PROXY_METADATA_TIMEOUT_MS
        : DIRECT_METADATA_TIMEOUT_MS;
    this.metadataDeadline = now + timeout;
    this.metadataMaxDeadline = now + PROXY_METADATA_MAX_TIMEOUT_MS;
    this.lastBufferedEnd = null;
    this.scheduleMetadataTimer();
  }

  markMetadataLoaded(): void {
    this.clearMetadataTimer();
    this.metadataDeadline = null;
    this.metadataMaxDeadline = null;
  }

  markProgress(bufferedEnd: number): void {
    if (
      this.mode !== "proxy" ||
      !Number.isFinite(bufferedEnd) ||
      (this.lastBufferedEnd !== null && bufferedEnd <= this.lastBufferedEnd)
    ) {
      return;
    }

    this.lastBufferedEnd = bufferedEnd;
    if (
      this.metadataTimer !== null &&
      this.metadataDeadline !== null &&
      this.metadataMaxDeadline !== null
    ) {
      const extendedDeadline = Math.min(
        Math.max(
          this.metadataDeadline,
          this.now() + PROXY_PROGRESS_EXTENSION_MS,
        ),
        this.metadataMaxDeadline,
      );
      if (extendedDeadline > this.metadataDeadline) {
        this.metadataDeadline = extendedDeadline;
        this.clearMetadataTimer();
        this.scheduleMetadataTimer();
      }
    }

    if (this.stallTimer !== null) {
      this.clearStallTimer();
      this.armStallTimeout();
    }
  }

  armStallTimeout(): void {
    if (this.stallTimer) {
      return;
    }
    this.stallTimer = setTimeout(
      () => {
        this.stallTimer = null;
        this.onFallback("stalled");
      },
      this.mode === "proxy" ? PROXY_STALL_TIMEOUT_MS : DIRECT_STALL_TIMEOUT_MS,
    );
  }

  markPlayable(): void {
    this.clearStallTimer();
  }

  dispose(): void {
    this.clearMetadataTimer();
    this.clearStallTimer();
    this.metadataDeadline = null;
    this.metadataMaxDeadline = null;
    this.lastBufferedEnd = null;
  }

  private scheduleMetadataTimer(): void {
    if (this.metadataDeadline === null) {
      return;
    }
    this.metadataTimer = setTimeout(
      () => {
        this.metadataTimer = null;
        this.metadataDeadline = null;
        this.metadataMaxDeadline = null;
        this.onFallback("metadata-timeout");
      },
      Math.max(0, this.metadataDeadline - this.now()),
    );
  }

  private clearMetadataTimer(): void {
    if (this.metadataTimer !== null) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = null;
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer !== null) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }
}
