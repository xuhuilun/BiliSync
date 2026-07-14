export type CachedVideoSummary = {
  id: string;
  title: string;
  streamUrl: string;
  size: number;
  updatedAt: number;
  status: "ready";
};

export type CachedVideoList = {
  enabled: boolean;
  videos: CachedVideoSummary[];
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readVideo(value: unknown): CachedVideoSummary | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  const { id, title, streamUrl, size, updatedAt, status } = record;
  if (
    typeof id !== "string" ||
    !/^cv_[A-Za-z0-9_-]{3,64}$/.test(id) ||
    typeof title !== "string" ||
    !title.trim() ||
    typeof streamUrl !== "string" ||
    streamUrl !== `/api/web/cached-videos/${id}/video.mp4` ||
    typeof size !== "number" ||
    !Number.isFinite(size) ||
    size < 0 ||
    typeof updatedAt !== "number" ||
    !Number.isFinite(updatedAt) ||
    updatedAt < 0 ||
    status !== "ready"
  ) {
    return null;
  }
  return { id, title: title.trim(), streamUrl, size, updatedAt, status };
}

export function readCachedVideoListResponse(value: unknown): CachedVideoList {
  const payload = readRecord(value);
  const data = readRecord(payload?.data);
  const videos = data?.videos;
  if (
    payload?.ok !== true ||
    typeof data?.enabled !== "boolean" ||
    !Array.isArray(videos)
  ) {
    throw new Error("Invalid cached video response.");
  }
  const parsedVideos = videos.map(readVideo);
  if (parsedVideos.some((video) => video === null)) {
    throw new Error("Invalid cached video response.");
  }
  return {
    enabled: data.enabled,
    videos: parsedVideos as CachedVideoSummary[],
  };
}

export function createCachedVideoPlaybackUrl(
  video: CachedVideoSummary,
  origin: string,
): string {
  return new URL(video.streamUrl, origin).toString();
}

export function shouldResolvePendingCachedVideo(
  previousMemberToken: string | null,
  session: { memberToken: string } | null,
): boolean {
  return Boolean(
    session &&
    (previousMemberToken === null ||
      session.memberToken !== previousMemberToken),
  );
}

export function getInitialWorkspaceView(
  roomCode: string,
  joinToken: string,
): "player" | "library" {
  return roomCode && joinToken ? "player" : "library";
}
