import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  PlaybackSourceManifest,
  PlaybackSourceVariant,
  SharedVideo,
} from "@bili-syncplay/protocol";
import type { PersistedRoom } from "./types.js";

const DIRECT_SOURCE_TTL_MS = 20 * 60 * 1000;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_TITLE_LENGTH = 128;

export type WebRoomService = {
  getRoom: (roomCode: string) => Promise<PersistedRoom | null>;
  isMemberTokenInRoom: (
    roomCode: string,
    memberToken: string,
  ) => Promise<boolean>;
};

type ResolveDirectVideoRequest = {
  url?: unknown;
  title?: unknown;
};

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, {
    ok: false,
    error: {
      code,
      message,
    },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_JSON_BODY_BYTES) {
      throw new Error("request_body_too_large");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function inferDirectVariant(url: string): PlaybackSourceVariant | null {
  const parsed = parseHttpUrl(url);
  if (!parsed) {
    return null;
  }

  const pathname = parsed.pathname.toLowerCase();
  if (pathname.endsWith(".m3u8")) {
    return {
      kind: "hls",
      url,
      mimeType: "application/vnd.apple.mpegurl",
      label: "HLS",
    };
  }
  if (pathname.endsWith(".mp4")) {
    return {
      kind: "mp4",
      url,
      mimeType: "video/mp4",
      label: "MP4",
    };
  }
  return null;
}

function slugDirectVideoId(url: URL): string {
  const source = url.pathname;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `direct:${slug || "video"}`;
}

function normalizeSourceRef(url: URL): string {
  const sourceRef = new URL(url);
  sourceRef.search = "";
  sourceRef.hash = "";
  return sourceRef.toString();
}

function createDirectManifest(args: {
  video: SharedVideo;
  expiresAt: number;
}): PlaybackSourceManifest | null {
  const variant = inferDirectVariant(args.video.url);
  if (!variant) {
    return null;
  }

  return {
    videoId: args.video.videoId,
    title: args.video.title,
    expiresAt: args.expiresAt,
    variants: [variant],
    ...(args.video.posterUrl ? { posterUrl: args.video.posterUrl } : {}),
  };
}

function createDirectSharedVideo(
  request: ResolveDirectVideoRequest,
): { video: SharedVideo; manifest: PlaybackSourceManifest } | null {
  const url = parseHttpUrl(request.url);
  if (!url) {
    return null;
  }

  const variant = inferDirectVariant(url.toString());
  if (!variant) {
    return null;
  }

  const trimmedTitle =
    typeof request.title === "string" ? request.title.trim() : "";
  const title = trimmedTitle.slice(0, MAX_TITLE_LENGTH) || url.pathname;
  const video: SharedVideo = {
    videoId: slugDirectVideoId(url),
    url: url.toString(),
    title,
    sourceProvider: "direct",
    sourceRef: normalizeSourceRef(url),
  };

  return {
    video,
    manifest: {
      videoId: video.videoId,
      title: video.title,
      expiresAt: 0,
      variants: [variant],
    },
  };
}

export async function tryHandleWebRoutes(args: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  roomService?: WebRoomService;
  now?: () => number;
}): Promise<boolean> {
  if (args.pathname === "/api/web/video/resolve") {
    if (args.request.method !== "POST") {
      writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
      return true;
    }

    try {
      const request = (await readJsonBody(
        args.request,
      )) as ResolveDirectVideoRequest;
      const resolved = createDirectSharedVideo(request);
      if (!resolved) {
        writeError(
          args.response,
          400,
          "invalid_direct_video",
          "Only direct HTTP(S) .m3u8 and .mp4 URLs are supported.",
        );
        return true;
      }

      writeJson(args.response, 200, {
        ok: true,
        data: {
          video: resolved.video,
          playbackSource: resolved.manifest,
        },
      });
    } catch {
      writeError(args.response, 400, "invalid_json", "Invalid JSON body.");
    }
    return true;
  }

  const playbackSourceMatch = args.pathname.match(
    /^\/api\/web\/rooms\/([A-Z0-9]{6})\/playback-source$/,
  );
  if (!playbackSourceMatch) {
    return false;
  }

  if (!args.roomService) {
    writeError(args.response, 404, "not_found", "Not found.");
    return true;
  }
  if (args.request.method !== "GET") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return true;
  }

  const requestUrl = new URL(args.request.url ?? "/", "http://localhost");
  const roomCode = playbackSourceMatch[1];
  const memberToken = requestUrl.searchParams.get("memberToken");
  if (
    !memberToken ||
    !(await args.roomService.isMemberTokenInRoom(roomCode, memberToken))
  ) {
    writeError(args.response, 404, "not_found", "Not found.");
    return true;
  }

  const room = await args.roomService.getRoom(roomCode);
  const sharedVideo = room?.sharedVideo;
  if (!sharedVideo || sharedVideo.sourceProvider !== "direct") {
    writeError(args.response, 404, "not_found", "Not found.");
    return true;
  }

  const manifest = createDirectManifest({
    video: sharedVideo,
    expiresAt: (args.now ?? Date.now)() + DIRECT_SOURCE_TTL_MS,
  });
  if (!manifest) {
    writeError(args.response, 404, "not_found", "Not found.");
    return true;
  }

  writeJson(args.response, 200, {
    ok: true,
    data: {
      playbackSource: manifest,
    },
  });
  return true;
}
