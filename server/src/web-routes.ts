import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  normalizeBilibiliUrl,
  parseBilibiliVideoRef,
  type PlaybackSourceManifest,
  type PlaybackSourceVariant,
  type SharedVideo,
} from "@bili-syncplay/protocol";
import type { PersistedRoom } from "./types.js";
import type { BilibiliMediaDeliveryMode } from "./config/media-delivery-config.js";
import type {
  WebMediaProxyUpstreamResult,
  WebMediaProxyUpstreamSource,
} from "./admin/metrics.js";

const DIRECT_SOURCE_TTL_MS = 20 * 60 * 1000;
const BILIBILI_AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BILIBILI_MEDIA_TOKEN_TTL_MS = 20 * 60 * 1000;
const BILIBILI_QR_LOGIN_TTL_MS = 180 * 1000;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_TITLE_LENGTH = 128;
const AUTH_COOKIE_NAME = "bili_sync_auth";
const DEFAULT_AUTH_SESSION_STORE_PATH = ".bili-syncplay/web-auth-sessions.json";
const BILIBILI_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export type WebRoomService = {
  getRoom: (roomCode: string) => Promise<PersistedRoom | null>;
  isMemberTokenInRoom: (
    roomCode: string,
    memberToken: string,
  ) => Promise<boolean>;
  resolveMemberIdByToken: (
    roomCode: string,
    memberToken: string,
  ) => Promise<string | null>;
};

export type BilibiliFetchResponse = {
  ok: boolean;
  status: number;
  headers: {
    get: (name: string) => string | null;
    getSetCookie?: () => string[];
  };
  body?: NodeReadableStream<Uint8Array> | null;
  json: () => Promise<unknown>;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type BilibiliFetch = (
  url: string,
  init?: {
    headers?: Record<string, string>;
  },
) => Promise<BilibiliFetchResponse>;

export type BilibiliAuthSession = {
  id: string;
  cookie: string;
  displayName: string;
  avatarUrl?: string;
  expiresAt: number;
};

export type WebAuthSessionStore = {
  load: () => Promise<BilibiliAuthSession[]>;
  save: (sessions: BilibiliAuthSession[]) => Promise<void>;
};

export type WebRouteDependencies = {
  fetch?: BilibiliFetch;
  createToken?: () => string;
  authSessionStore?: WebAuthSessionStore;
  mediaDeliveryMode?: BilibiliMediaDeliveryMode;
  mediaMetrics?: {
    recordManifestIssued: (
      mode: BilibiliMediaDeliveryMode,
      directCandidateCount: number,
    ) => void;
    recordProxyRequest: () => void;
    recordProxyBytes: (bytes: number) => void;
    recordProxyUpstreamAttempt: (
      source: WebMediaProxyUpstreamSource,
      result: WebMediaProxyUpstreamResult,
      durationMs: number,
    ) => void;
  };
  trtc?: {
    sdkAppId: number;
    expireSeconds: number;
    generateUserSig: (userId: string) => string;
    generatePrivateMapKey: (userId: string, roomId: string) => string;
  };
};

type BilibiliQrLoginSession = {
  qrcodeKey: string;
  loginUrl: string;
  expiresAt: number;
};

type BilibiliMediaToken = {
  url: string;
  cookie: string;
  referer: string;
  expiresAt: number;
};

type BilibiliMediaSources = {
  primaryUrl: string;
  backupUrls: string[];
};

export type WebRouteState = {
  authSessions: Map<string, BilibiliAuthSession>;
  authSessionsLoaded: boolean;
  authSessionStore?: WebAuthSessionStore;
  qrLoginSessions: Map<string, BilibiliQrLoginSession>;
  mediaTokens: Map<string, BilibiliMediaToken>;
  sourceAuthSessions: Map<string, string>;
};

type ResolveVideoRequest = {
  url?: unknown;
  title?: unknown;
  input?: unknown;
  roomCode?: unknown;
  memberToken?: unknown;
};

type VoiceTokenRequest = {
  roomCode?: unknown;
  memberToken?: unknown;
};

type BilibiliVideoInfo = {
  bvid: string | null;
  aid: number | null;
  epId?: number | null;
  cid: number;
  title: string;
  posterUrl?: string;
  duration?: number;
  normalizedUrl: string;
  videoId: string;
  sourceRef: string;
};

function defaultCreateToken(): string {
  return randomBytes(24).toString("base64url");
}

function createTrtcUserId(memberId: string): string {
  const digest = createHash("sha256")
    .update(memberId)
    .digest("hex")
    .slice(0, 28);
  return `web_${digest}`;
}

async function handleVoiceToken(args: {
  request: IncomingMessage;
  response: ServerResponse;
  roomService?: WebRoomService;
  trtc?: NonNullable<WebRouteDependencies["trtc"]>;
}): Promise<void> {
  if (args.request.method !== "POST") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }
  if (!args.trtc || !args.roomService) {
    writeError(
      args.response,
      503,
      "voice_unavailable",
      "Voice chat is not configured.",
    );
    return;
  }

  const body = (await readJsonBody(args.request)) as VoiceTokenRequest;
  const roomCode =
    typeof body.roomCode === "string" ? body.roomCode.trim().toUpperCase() : "";
  const memberToken =
    typeof body.memberToken === "string" ? body.memberToken.trim() : "";
  if (
    !/^[A-Z0-9]{6}$/.test(roomCode) ||
    !memberToken ||
    !(await args.roomService.isMemberTokenInRoom(roomCode, memberToken))
  ) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  const memberId = await args.roomService.resolveMemberIdByToken(
    roomCode,
    memberToken,
  );
  if (!memberId) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }
  const userId = createTrtcUserId(memberId);
  writeJson(args.response, 200, {
    ok: true,
    data: {
      sdkAppId: args.trtc.sdkAppId,
      userId,
      userSig: args.trtc.generateUserSig(userId),
      privateMapKey: args.trtc.generatePrivateMapKey(userId, roomCode),
      roomId: roomCode,
      expiresInSeconds: args.trtc.expireSeconds,
    },
  });
}

function defaultFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<BilibiliFetchResponse> {
  return fetch(url, init) as Promise<BilibiliFetchResponse>;
}

function readPersistedAuthSession(value: unknown): BilibiliAuthSession | null {
  const record = readRecord(value);
  if (!record) {
    return null;
  }
  const id = record.id;
  const cookie = record.cookie;
  const displayName = record.displayName;
  const avatarUrl = record.avatarUrl;
  const expiresAt = record.expiresAt;
  if (
    typeof id !== "string" ||
    typeof cookie !== "string" ||
    typeof displayName !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  return {
    id,
    cookie,
    displayName,
    ...(typeof avatarUrl === "string" ? { avatarUrl } : {}),
    expiresAt,
  };
}

export function createFileWebAuthSessionStore(
  filePath = DEFAULT_AUTH_SESSION_STORE_PATH,
): WebAuthSessionStore {
  const resolvedPath = resolve(filePath);
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(resolvedPath, "utf8");
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return [];
        }
        throw error;
      }
      const payload = readRecord(JSON.parse(raw));
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      return sessions
        .map(readPersistedAuthSession)
        .filter((session): session is BilibiliAuthSession => session !== null);
    },
    async save(sessions) {
      await mkdir(dirname(resolvedPath), { recursive: true });
      const temporaryPath = `${resolvedPath}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`,
        "utf8",
      );
      await rename(temporaryPath, resolvedPath);
    },
  };
}

export function createWebRouteState(
  args: {
    authSessionStore?: WebAuthSessionStore;
  } = {},
): WebRouteState {
  return {
    authSessions: new Map(),
    authSessionsLoaded: !args.authSessionStore,
    ...(args.authSessionStore
      ? { authSessionStore: args.authSessionStore }
      : {}),
    qrLoginSessions: new Map(),
    mediaTokens: new Map(),
    sourceAuthSessions: new Map(),
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
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

function writeBuffer(
  response: ServerResponse,
  statusCode: number,
  body: ArrayBuffer | Buffer,
  headers: Record<string, string>,
): void {
  response.writeHead(statusCode, {
    "cache-control": "private, max-age=60",
    ...headers,
  });
  response.end(
    Buffer.isBuffer(body) ? body : Buffer.from(new Uint8Array(body)),
  );
}

function createMediaProxyResponseHeaders(
  upstreamHeaders: BilibiliFetchResponse["headers"],
): Record<string, string> {
  const responseHeaders: Record<string, string> = {
    "cache-control": "private, max-age=60",
  };
  for (const headerName of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]) {
    const value = upstreamHeaders.get(headerName);
    if (value) {
      responseHeaders[headerName] = value;
    }
  }
  return responseHeaders;
}

async function pipeMediaProxyResponse(args: {
  response: ServerResponse;
  upstream: BilibiliFetchResponse;
}): Promise<void> {
  const statusCode = args.upstream.status === 206 ? 206 : 200;
  const headers = createMediaProxyResponseHeaders(args.upstream.headers);
  if (!args.upstream.body) {
    writeBuffer(
      args.response,
      statusCode,
      await args.upstream.arrayBuffer(),
      headers,
    );
    return;
  }

  args.response.writeHead(statusCode, headers);
  try {
    await pipeline(
      Readable.fromWeb(args.upstream.body as NodeReadableStream<Uint8Array>),
      args.response,
    );
  } catch {
    if (!args.response.destroyed && !args.response.writableEnded) {
      args.response.destroy();
    }
  }
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
  request: ResolveVideoRequest,
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

function getCookieHeader(request: IncomingMessage): string {
  const header = request.headers.cookie;
  return Array.isArray(header) ? header.join("; ") : (header ?? "");
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const cookies = getCookieHeader(request).split(";");
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName === name) {
      return rawValue.join("=") || null;
    }
  }
  return null;
}

async function hydrateAuthSessions(
  state: WebRouteState,
  currentTime: number,
): Promise<void> {
  if (state.authSessionsLoaded) {
    return;
  }
  state.authSessionsLoaded = true;
  if (!state.authSessionStore) {
    return;
  }
  const sessions = await state.authSessionStore.load();
  let changed = false;
  for (const session of sessions) {
    if (session.expiresAt <= currentTime) {
      changed = true;
      continue;
    }
    state.authSessions.set(session.id, session);
  }
  if (changed) {
    await persistAuthSessions(state, currentTime);
  }
}

async function persistAuthSessions(
  state: WebRouteState,
  currentTime: number,
): Promise<void> {
  if (!state.authSessionStore) {
    return;
  }
  const sessions = [...state.authSessions.values()].filter(
    (session) => session.expiresAt > currentTime,
  );
  await state.authSessionStore.save(sessions);
}

async function getAuthSession(
  request: IncomingMessage,
  state: WebRouteState,
  currentTime: number,
): Promise<BilibiliAuthSession | null> {
  await hydrateAuthSessions(state, currentTime);
  const token = readCookie(request, AUTH_COOKIE_NAME);
  if (!token) {
    return null;
  }
  const session = state.authSessions.get(token) ?? null;
  if (!session || session.expiresAt <= currentTime) {
    state.authSessions.delete(token);
    await persistAuthSessions(state, currentTime);
    return null;
  }
  return session;
}

function buildBilibiliHeaders(
  cookie: string,
  referer = "https://www.bilibili.com/",
): Record<string, string> {
  return {
    cookie,
    referer,
    "user-agent": BILIBILI_USER_AGENT,
  };
}

function createBilibiliQrGenerateUrl(): string {
  return "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
}

function createBilibiliQrPollUrl(qrcodeKey: string): string {
  const url = new URL(
    "https://passport.bilibili.com/x/passport-login/web/qrcode/poll",
  );
  url.searchParams.set("qrcode_key", qrcodeKey);
  return url.toString();
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=[^;]*)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function readSetCookies(headers: BilibiliFetchResponse["headers"]): string[] {
  const explicitCookies = headers.getSetCookie?.();
  if (explicitCookies?.length) {
    return explicitCookies;
  }
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function createCookieHeaderFromSetCookies(setCookies: string[]): string {
  const allowedNames = new Set([
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
  ]);
  return setCookies
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter((pair) => {
      const name = pair.split("=")[0];
      return name ? allowedNames.has(name) : false;
    })
    .join("; ");
}

type ParsedBilibiliInput =
  | {
      kind: "ugc";
      bvid?: string;
      aid?: string;
      normalizedUrl: string;
      page?: number;
    }
  | {
      kind: "pgc";
      epId: number;
      normalizedUrl: string;
    };

function parseB23Url(input: string): URL | null {
  const parsed = parseHttpUrl(input);
  if (!parsed) {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "b23.tv" || hostname === "www.b23.tv" ? parsed : null;
}

function looksLikeSupportedBilibiliInput(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const input = value.trim();
  if (!input) {
    return false;
  }
  if (/^(BV[0-9A-Za-z]+)$/i.test(input) || /^(?:av)?(\d+)$/i.test(input)) {
    return true;
  }
  if (parseB23Url(input)) {
    return true;
  }
  const parsed = parseBilibiliVideoRef(input);
  if (!parsed) {
    return false;
  }
  const videoPart = parsed.videoId.split(":")[0] ?? "";
  return /^(BV[0-9A-Za-z]+|av\d+|ep\d+)$/i.test(videoPart);
}

function parseBilibiliInput(value: unknown): ParsedBilibiliInput | null {
  if (typeof value !== "string") {
    return null;
  }
  const input = value.trim();
  if (!input) {
    return null;
  }

  const bvidMatch = input.match(/^(BV[0-9A-Za-z]+)$/i);
  if (bvidMatch) {
    const bvid = bvidMatch[1];
    return {
      kind: "ugc",
      bvid,
      normalizedUrl: `https://www.bilibili.com/video/${bvid}`,
    };
  }

  const aidMatch = input.match(/^(?:av)?(\d+)$/i);
  if (aidMatch) {
    const aid = aidMatch[1];
    return {
      kind: "ugc",
      aid,
      normalizedUrl: `https://www.bilibili.com/video/av${aid}`,
    };
  }

  const parsed = parseBilibiliVideoRef(input);
  if (!parsed) {
    return null;
  }
  const videoPart = parsed.videoId.split(":")[0] ?? "";
  const pagePart = parsed.videoId.split(":")[1];
  const page =
    pagePart?.startsWith("p") && Number.isInteger(Number(pagePart.slice(1)))
      ? Number(pagePart.slice(1))
      : undefined;
  if (videoPart.startsWith("BV")) {
    return {
      kind: "ugc",
      bvid: videoPart,
      normalizedUrl: parsed.normalizedUrl,
      page,
    };
  }
  if (videoPart.startsWith("av")) {
    return {
      kind: "ugc",
      aid: videoPart.slice(2),
      normalizedUrl: parsed.normalizedUrl,
      page,
    };
  }
  if (videoPart.startsWith("ep")) {
    const epId = Number(videoPart.slice(2));
    if (Number.isInteger(epId) && epId > 0) {
      return {
        kind: "pgc",
        epId,
        normalizedUrl: `https://www.bilibili.com/bangumi/play/ep${epId}`,
      };
    }
  }
  return null;
}

async function expandB23ShortLink(args: {
  input: string;
  fetchImpl: BilibiliFetch;
}): Promise<string> {
  let current = args.input;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shortUrl = parseB23Url(current);
    if (!shortUrl) {
      return current;
    }
    const response = await args.fetchImpl(shortUrl.toString(), {
      headers: {
        referer: "https://www.bilibili.com/",
        "user-agent": BILIBILI_USER_AGENT,
      },
    });
    const redirectedUrl =
      response.headers.get("location") ??
      (response as BilibiliFetchResponse & { url?: string }).url;
    if (!redirectedUrl || redirectedUrl === current) {
      throw new Error("unsupported_bilibili_link");
    }
    current = new URL(redirectedUrl, shortUrl).toString();
  }
  throw new Error("unsupported_bilibili_link");
}

async function resolveBilibiliInput(args: {
  input: string;
  fetchImpl: BilibiliFetch;
}): Promise<ParsedBilibiliInput> {
  const expandedInput = await expandB23ShortLink({
    input: args.input.trim(),
    fetchImpl: args.fetchImpl,
  });
  const parsedInput = parseBilibiliInput(expandedInput);
  if (!parsedInput) {
    throw new Error("unsupported_bilibili_link");
  }
  return parsedInput;
}

function createBilibiliViewUrl(
  input: Extract<ParsedBilibiliInput, { kind: "ugc" }>,
): string {
  const url = new URL("https://api.bilibili.com/x/web-interface/view");
  if (input.bvid) {
    url.searchParams.set("bvid", input.bvid);
  } else if (input.aid) {
    url.searchParams.set("aid", input.aid);
  }
  return url.toString();
}

function createBilibiliPgcSeasonUrl(epId: number): string {
  const url = new URL("https://api.bilibili.com/pgc/view/web/season");
  url.searchParams.set("ep_id", String(epId));
  return url.toString();
}

function createBilibiliPlayUrl(info: BilibiliVideoInfo): string {
  const url = info.epId
    ? new URL("https://api.bilibili.com/pgc/player/web/playurl")
    : new URL("https://api.bilibili.com/x/player/playurl");
  if (info.epId) {
    url.searchParams.set("ep_id", String(info.epId));
  } else {
    if (info.bvid) {
      url.searchParams.set("bvid", info.bvid);
    } else if (info.aid !== null) {
      url.searchParams.set("avid", String(info.aid));
    }
  }
  url.searchParams.set("cid", String(info.cid));
  url.searchParams.set("qn", "80");
  url.searchParams.set("fnval", "0");
  url.searchParams.set("fourk", "0");
  return url.toString();
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function assertBilibiliOk(payload: unknown): Record<string, unknown> {
  const record = readRecord(payload);
  if (!record || record.code !== 0) {
    throw new Error("bilibili_api_error");
  }
  const data = readRecord(record.data);
  if (!data) {
    throw new Error("bilibili_api_error");
  }
  return data;
}

function assertBilibiliResult(payload: unknown): Record<string, unknown> {
  const record = readRecord(payload);
  if (!record || record.code !== 0) {
    throw new Error("bilibili_api_error");
  }
  const result = readRecord(record.result);
  if (!result) {
    throw new Error("bilibili_api_error");
  }
  return result;
}

async function validateBilibiliCookie(args: {
  cookie: string;
  fetchImpl: BilibiliFetch;
}): Promise<{ displayName: string; avatarUrl?: string }> {
  const response = await args.fetchImpl(
    "https://api.bilibili.com/x/web-interface/nav",
    {
      headers: buildBilibiliHeaders(args.cookie),
    },
  );
  const data = assertBilibiliOk(await response.json());
  if (data.isLogin !== true) {
    throw new Error("bilibili_not_logged_in");
  }
  const displayName =
    typeof data.uname === "string" && data.uname.trim()
      ? data.uname.trim().slice(0, 32)
      : "B???";
  return {
    displayName,
    ...(typeof data.face === "string" && parseHttpUrl(data.face)
      ? { avatarUrl: data.face }
      : {}),
  };
}

function readPositiveNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  return null;
}

function readTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value > 10_000 ? Math.round(value / 1000) : value;
}

function pickCid(data: Record<string, unknown>, page?: number): number {
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const pageItem =
    page && page > 0 ? readRecord(pages[page - 1]) : readRecord(pages[0]);
  const pageCid = pageItem?.cid;
  if (typeof pageCid === "number" && Number.isFinite(pageCid)) {
    return pageCid;
  }
  if (typeof data.cid === "number" && Number.isFinite(data.cid)) {
    return data.cid;
  }
  throw new Error("bilibili_cid_missing");
}

function buildPgcEpisodeTitle(args: {
  seasonTitle: string | null;
  episode: Record<string, unknown>;
  fallback: string;
}): string {
  const parts = [
    args.seasonTitle,
    readTrimmedString(args.episode, "title"),
    readTrimmedString(args.episode, "long_title"),
  ].filter((part): part is string => Boolean(part));
  return (parts.join(" ") || args.fallback).slice(0, MAX_TITLE_LENGTH);
}

async function resolveBilibiliUgcVideoInfo(args: {
  input: Extract<ParsedBilibiliInput, { kind: "ugc" }>;
  cookie: string;
  fetchImpl: BilibiliFetch;
}): Promise<BilibiliVideoInfo> {
  const response = await args.fetchImpl(createBilibiliViewUrl(args.input), {
    headers: buildBilibiliHeaders(args.cookie),
  });
  const data = assertBilibiliOk(await response.json());
  const cid = pickCid(data, args.input.page);
  const bvid = typeof data.bvid === "string" ? data.bvid : null;
  const aid = typeof data.aid === "number" ? data.aid : null;
  const videoKey = bvid ?? (aid !== null ? `av${aid}` : null);
  if (!videoKey) {
    throw new Error("bilibili_video_id_missing");
  }

  const normalizedUrl =
    normalizeBilibiliUrl(args.input.normalizedUrl) ??
    `https://www.bilibili.com/video/${videoKey}`;
  const videoId = `${videoKey}:${cid}`;
  return {
    bvid,
    aid,
    cid,
    title:
      typeof data.title === "string" && data.title.trim()
        ? data.title.trim().slice(0, MAX_TITLE_LENGTH)
        : videoId,
    posterUrl: typeof data.pic === "string" ? data.pic : undefined,
    duration:
      typeof data.duration === "number" && data.duration >= 0
        ? data.duration
        : undefined,
    normalizedUrl,
    videoId,
    sourceRef: `${videoKey}:${cid}`,
  };
}

async function resolveBilibiliPgcVideoInfo(args: {
  input: Extract<ParsedBilibiliInput, { kind: "pgc" }>;
  cookie: string;
  fetchImpl: BilibiliFetch;
}): Promise<BilibiliVideoInfo> {
  const response = await args.fetchImpl(
    createBilibiliPgcSeasonUrl(args.input.epId),
    {
      headers: buildBilibiliHeaders(args.cookie, args.input.normalizedUrl),
    },
  );
  const result = assertBilibiliResult(await response.json());
  const episodes = Array.isArray(result.episodes) ? result.episodes : [];
  const episode = episodes
    .map(readRecord)
    .find((item): item is Record<string, unknown> => {
      if (!item) {
        return false;
      }
      return readPositiveNumber(item, ["id", "ep_id"]) === args.input.epId;
    });
  if (!episode) {
    throw new Error("bilibili_api_error");
  }
  const cid = readPositiveNumber(episode, ["cid"]);
  if (!cid) {
    throw new Error("bilibili_cid_missing");
  }

  const videoKey = `ep${args.input.epId}`;
  return {
    bvid: readTrimmedString(episode, "bvid"),
    aid: readPositiveNumber(episode, ["aid"]),
    epId: args.input.epId,
    cid,
    title: buildPgcEpisodeTitle({
      seasonTitle: readTrimmedString(result, "season_title"),
      episode,
      fallback: videoKey,
    }),
    posterUrl:
      readTrimmedString(episode, "cover") ??
      readTrimmedString(result, "cover") ??
      undefined,
    duration: normalizeDurationSeconds(episode.duration),
    normalizedUrl: args.input.normalizedUrl,
    videoId: `${videoKey}:${cid}`,
    sourceRef: `${videoKey}:${cid}`,
  };
}

async function resolveBilibiliVideoInfo(args: {
  input: string;
  cookie: string;
  fetchImpl: BilibiliFetch;
}): Promise<BilibiliVideoInfo> {
  const parsedInput = await resolveBilibiliInput({
    input: args.input,
    fetchImpl: args.fetchImpl,
  });
  if (parsedInput.kind === "pgc") {
    return resolveBilibiliPgcVideoInfo({
      input: parsedInput,
      cookie: args.cookie,
      fetchImpl: args.fetchImpl,
    });
  }
  return resolveBilibiliUgcVideoInfo({
    input: parsedInput,
    cookie: args.cookie,
    fetchImpl: args.fetchImpl,
  });
}

async function resolveBilibiliMediaSources(args: {
  info: BilibiliVideoInfo;
  cookie: string;
  fetchImpl: BilibiliFetch;
}): Promise<BilibiliMediaSources> {
  const response = await args.fetchImpl(createBilibiliPlayUrl(args.info), {
    headers: buildBilibiliHeaders(args.cookie, args.info.normalizedUrl),
  });
  const data = assertBilibiliOk(await response.json());
  const durl = Array.isArray(data.durl) ? data.durl : [];
  const first = readRecord(durl[0]);
  const primaryUrl = first?.url;
  if (typeof primaryUrl !== "string" || !parseHttpUrl(primaryUrl)) {
    throw new Error("bilibili_media_url_missing");
  }
  const seen = new Set([primaryUrl]);
  const backupUrls = (Array.isArray(first?.backup_url) ? first.backup_url : [])
    .filter((value): value is string => typeof value === "string")
    .filter((value) => parseHttpUrl(value) !== null)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    });
  return { primaryUrl, backupUrls };
}

function createBilibiliManifest(args: {
  info: BilibiliVideoInfo;
  mediaSources: BilibiliMediaSources;
  mediaToken: string;
  expiresAt: number;
  deliveryMode?: BilibiliMediaDeliveryMode;
  roomCode?: string;
  memberToken?: string;
}): PlaybackSourceManifest {
  const query =
    args.roomCode && args.memberToken
      ? `?roomCode=${encodeURIComponent(args.roomCode)}&memberToken=${encodeURIComponent(args.memberToken)}`
      : "";
  const proxyVariant: PlaybackSourceVariant = {
    kind: "mp4",
    url: `/api/web/media/${args.mediaToken}/video.mp4${query}`,
    mimeType: "video/mp4",
    label: "服务器代理",
  };
  const variants =
    args.deliveryMode === "proxy-only"
      ? [proxyVariant]
      : [
          {
            kind: "mp4" as const,
            url: args.mediaSources.primaryUrl,
            mimeType: "video/mp4",
            label: "B站 CDN",
          },
          ...args.mediaSources.backupUrls.map((url, index) => ({
            kind: "mp4" as const,
            url,
            mimeType: "video/mp4",
            label: `B站备用 CDN ${index + 1}`,
          })),
          proxyVariant,
        ];
  return {
    videoId: args.info.videoId,
    title: args.info.title,
    expiresAt: args.expiresAt,
    variants,
    ...(args.info.posterUrl ? { posterUrl: args.info.posterUrl } : {}),
  };
}

function createBilibiliSharedVideo(info: BilibiliVideoInfo): SharedVideo {
  return {
    videoId: info.videoId,
    url: info.normalizedUrl,
    title: info.title,
    sourceProvider: "authorized-bilibili",
    sourceRef: info.sourceRef,
    ...(info.posterUrl ? { posterUrl: info.posterUrl } : {}),
    ...(info.duration !== undefined ? { duration: info.duration } : {}),
  };
}

function parseBilibiliSourceRef(sourceRef: string): BilibiliVideoInfo | null {
  const match = sourceRef.match(/^(BV[0-9A-Za-z]+|av\d+|ep\d+):(\d+)$/);
  if (!match) {
    return null;
  }
  const key = match[1];
  const cid = Number(match[2]);
  const bvid = key.startsWith("BV") ? key : null;
  const aid = key.startsWith("av") ? Number(key.slice(2)) : null;
  const epId = key.startsWith("ep") ? Number(key.slice(2)) : null;
  const normalizedUrl = epId
    ? `https://www.bilibili.com/bangumi/play/ep${epId}`
    : `https://www.bilibili.com/video/${key}`;
  return {
    bvid,
    aid,
    epId,
    cid,
    title: key,
    normalizedUrl,
    videoId: `${key}:${cid}`,
    sourceRef,
  };
}

async function handleBilibiliLoginStart(args: {
  request: IncomingMessage;
  response: ServerResponse;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  now: () => number;
}): Promise<void> {
  if (args.request.method !== "POST") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }
  try {
    const response = await args.fetchImpl(createBilibiliQrGenerateUrl(), {
      headers: {
        referer: "https://www.bilibili.com/",
        "user-agent": BILIBILI_USER_AGENT,
      },
    });
    const data = assertBilibiliOk(await response.json());
    const loginUrl = typeof data.url === "string" ? data.url : "";
    const qrcodeKey =
      typeof data.qrcode_key === "string" ? data.qrcode_key : "";
    if (!loginUrl || !qrcodeKey) {
      throw new Error("bilibili_qr_missing");
    }
    args.state.qrLoginSessions.set(qrcodeKey, {
      qrcodeKey,
      loginUrl,
      expiresAt: args.now() + BILIBILI_QR_LOGIN_TTL_MS,
    });
    writeJson(args.response, 200, {
      ok: true,
      data: {
        loginUrl,
        qrcodeKey,
        expiresInSeconds: Math.floor(BILIBILI_QR_LOGIN_TTL_MS / 1000),
      },
    });
  } catch {
    writeError(
      args.response,
      502,
      "bilibili_login_failed",
      "Unable to create a Bilibili QR login session.",
    );
  }
}

async function handleBilibiliQrLoginStatus(args: {
  request: IncomingMessage;
  response: ServerResponse;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  createToken: () => string;
  qrcodeKey: string;
  now: () => number;
}): Promise<void> {
  const session = args.state.qrLoginSessions.get(args.qrcodeKey);
  if (!session || session.expiresAt <= args.now()) {
    args.state.qrLoginSessions.delete(args.qrcodeKey);
    writeJson(args.response, 200, {
      ok: true,
      data: {
        loggedIn: false,
        qrStatus: "expired",
      },
    });
    return;
  }

  try {
    const pollResponse = await args.fetchImpl(
      createBilibiliQrPollUrl(args.qrcodeKey),
      {
        headers: {
          referer: "https://www.bilibili.com/",
          "user-agent": BILIBILI_USER_AGENT,
        },
      },
    );
    const data = assertBilibiliOk(await pollResponse.json());
    const qrCode = typeof data.code === "number" ? data.code : null;
    if (qrCode === 86101) {
      writeJson(args.response, 200, {
        ok: true,
        data: {
          loggedIn: false,
          qrStatus: "pending",
        },
      });
      return;
    }
    if (qrCode === 86090) {
      writeJson(args.response, 200, {
        ok: true,
        data: {
          loggedIn: false,
          qrStatus: "scanned",
        },
      });
      return;
    }
    if (qrCode === 86038) {
      args.state.qrLoginSessions.delete(args.qrcodeKey);
      writeJson(args.response, 200, {
        ok: true,
        data: {
          loggedIn: false,
          qrStatus: "expired",
        },
      });
      return;
    }
    if (qrCode !== 0) {
      throw new Error("bilibili_qr_status_unknown");
    }

    const cookie = createCookieHeaderFromSetCookies(
      readSetCookies(pollResponse.headers),
    );
    if (!cookie) {
      throw new Error("bilibili_qr_cookie_missing");
    }
    const profile = await validateBilibiliCookie({
      cookie,
      fetchImpl: args.fetchImpl,
    });
    const token = args.createToken();
    args.state.qrLoginSessions.delete(args.qrcodeKey);
    const authSession: BilibiliAuthSession = {
      id: token,
      cookie,
      displayName: profile.displayName,
      ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
      expiresAt: args.now() + BILIBILI_AUTH_SESSION_TTL_MS,
    };
    args.state.authSessions.set(token, authSession);
    await persistAuthSessions(args.state, args.now());
    writeJson(
      args.response,
      200,
      {
        ok: true,
        data: {
          loggedIn: true,
          displayName: profile.displayName,
          ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
          qrStatus: "succeeded",
        },
      },
      {
        "set-cookie": `${AUTH_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
          BILIBILI_AUTH_SESSION_TTL_MS / 1000,
        )}`,
      },
    );
  } catch {
    writeError(
      args.response,
      401,
      "bilibili_login_failed",
      "Bilibili QR login is not authorized or has expired.",
    );
  }
}

async function handleBilibiliLoginStatus(args: {
  request: IncomingMessage;
  response: ServerResponse;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  createToken: () => string;
  now: () => number;
}): Promise<void> {
  if (args.request.method !== "GET") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }
  const requestUrl = new URL(args.request.url ?? "/", "http://localhost");
  const qrcodeKey = requestUrl.searchParams.get("qrcodeKey");
  if (qrcodeKey) {
    await handleBilibiliQrLoginStatus({
      request: args.request,
      response: args.response,
      state: args.state,
      fetchImpl: args.fetchImpl,
      createToken: args.createToken,
      qrcodeKey,
      now: args.now,
    });
    return;
  }
  const session = await getAuthSession(args.request, args.state, args.now());
  writeJson(args.response, 200, {
    ok: true,
    data: session
      ? {
          loggedIn: true,
          displayName: session.displayName,
          ...(session.avatarUrl ? { avatarUrl: session.avatarUrl } : {}),
        }
      : {
          loggedIn: false,
        },
  });
}

async function handleBilibiliLogout(args: {
  request: IncomingMessage;
  response: ServerResponse;
  state: WebRouteState;
  now: () => number;
}): Promise<void> {
  if (args.request.method !== "POST") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }
  const token = readCookie(args.request, AUTH_COOKIE_NAME);
  if (token) {
    await hydrateAuthSessions(args.state, args.now());
    args.state.authSessions.delete(token);
    await persistAuthSessions(args.state, args.now());
  }
  writeJson(
    args.response,
    200,
    {
      ok: true,
      data: {
        loggedIn: false,
      },
    },
    {
      "set-cookie": `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  );
}

async function handleVideoResolve(args: {
  request: IncomingMessage;
  response: ServerResponse;
  roomService?: WebRoomService;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  createToken: () => string;
  mediaDeliveryMode?: BilibiliMediaDeliveryMode;
  mediaMetrics?: WebRouteDependencies["mediaMetrics"];
  now: () => number;
}): Promise<void> {
  if (args.request.method !== "POST") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }

  try {
    const request = (await readJsonBody(args.request)) as ResolveVideoRequest;
    const direct = createDirectSharedVideo(request);
    if (direct) {
      writeJson(args.response, 200, {
        ok: true,
        data: {
          video: direct.video,
          playbackSource: direct.manifest,
        },
      });
      return;
    }

    const input =
      typeof request.input === "string"
        ? request.input
        : typeof request.url === "string"
          ? request.url
          : "";
    const trimmedInput = input.trim();
    if (!trimmedInput) {
      writeError(args.response, 400, "empty_video_link", "请先粘贴视频链接。");
      return;
    }
    if (!looksLikeSupportedBilibiliInput(trimmedInput)) {
      writeError(
        args.response,
        400,
        "unsupported_bilibili_link",
        "暂不支持该链接格式，请检查后重试。",
      );
      return;
    }
    const authSession = await getAuthSession(
      args.request,
      args.state,
      args.now(),
    );
    if (!authSession) {
      writeError(
        args.response,
        401,
        "bilibili_login_required",
        "Login with a Bilibili cookie before resolving Bilibili videos.",
      );
      return;
    }
    const isCurrentRoomMember =
      args.roomService &&
      typeof request.roomCode === "string" &&
      typeof request.memberToken === "string"
        ? await args.roomService.isMemberTokenInRoom(
            request.roomCode,
            request.memberToken,
          )
        : false;
    const deliveryMode: BilibiliMediaDeliveryMode =
      (args.mediaDeliveryMode ?? "direct-first") === "direct-first" &&
      isCurrentRoomMember
        ? "direct-first"
        : "proxy-only";

    const info = await resolveBilibiliVideoInfo({
      input: trimmedInput,
      cookie: authSession.cookie,
      fetchImpl: args.fetchImpl,
    });
    const mediaSources = await resolveBilibiliMediaSources({
      info,
      cookie: authSession.cookie,
      fetchImpl: args.fetchImpl,
    });
    args.state.sourceAuthSessions.set(info.sourceRef, authSession.id);
    const mediaToken = args.createToken();
    const expiresAt = args.now() + BILIBILI_MEDIA_TOKEN_TTL_MS;
    args.state.mediaTokens.set(mediaToken, {
      url: mediaSources.primaryUrl,
      cookie: authSession.cookie,
      referer: info.normalizedUrl,
      expiresAt,
    });
    args.mediaMetrics?.recordManifestIssued(
      deliveryMode,
      deliveryMode === "proxy-only" ? 0 : 1 + mediaSources.backupUrls.length,
    );

    writeJson(args.response, 200, {
      ok: true,
      data: {
        video: createBilibiliSharedVideo(info),
        playbackSource: createBilibiliManifest({
          info,
          mediaSources,
          mediaToken,
          expiresAt,
          deliveryMode,
        }),
      },
    });
  } catch (reason) {
    const errorCode = reason instanceof Error ? reason.message : "";
    if (errorCode === "unsupported_bilibili_link") {
      writeError(
        args.response,
        400,
        "unsupported_bilibili_link",
        "暂不支持该链接格式，请检查后重试。",
      );
      return;
    }
    if (
      errorCode === "bilibili_api_error" ||
      errorCode === "bilibili_cid_missing" ||
      errorCode === "bilibili_video_id_missing" ||
      errorCode === "bilibili_media_url_missing"
    ) {
      writeError(
        args.response,
        400,
        "invalid_bilibili_video",
        "视频不存在或当前账号无观看权限。",
      );
      return;
    }
    writeError(
      args.response,
      502,
      "bilibili_resolve_failed",
      "解析失败，请稍后重试。",
    );
  }
}

async function handlePlaybackSource(args: {
  request: IncomingMessage;
  response: ServerResponse;
  roomCode: string;
  roomService?: WebRoomService;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  createToken: () => string;
  mediaDeliveryMode?: BilibiliMediaDeliveryMode;
  mediaMetrics?: WebRouteDependencies["mediaMetrics"];
  now: () => number;
}): Promise<void> {
  if (!args.roomService) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }
  if (args.request.method !== "GET") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }

  const requestUrl = new URL(args.request.url ?? "/", "http://localhost");
  const memberToken = requestUrl.searchParams.get("memberToken");
  if (
    !memberToken ||
    !(await args.roomService.isMemberTokenInRoom(args.roomCode, memberToken))
  ) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  const room = await args.roomService.getRoom(args.roomCode);
  const sharedVideo = room?.sharedVideo;
  if (!sharedVideo) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  if (sharedVideo.sourceProvider === "direct") {
    const manifest = createDirectManifest({
      video: sharedVideo,
      expiresAt: args.now() + DIRECT_SOURCE_TTL_MS,
    });
    if (!manifest) {
      writeError(args.response, 404, "not_found", "Not found.");
      return;
    }

    writeJson(args.response, 200, {
      ok: true,
      data: {
        playbackSource: manifest,
      },
    });
    return;
  }

  if (
    sharedVideo.sourceProvider !== "authorized-bilibili" ||
    !sharedVideo.sourceRef
  ) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  const sourceInfo = parseBilibiliSourceRef(sharedVideo.sourceRef);
  const authSessionId = args.state.sourceAuthSessions.get(
    sharedVideo.sourceRef,
  );
  await hydrateAuthSessions(args.state, args.now());
  const authSession = authSessionId
    ? (args.state.authSessions.get(authSessionId) ?? null)
    : await getAuthSession(args.request, args.state, args.now());
  if (!sourceInfo || !authSession || authSession.expiresAt <= args.now()) {
    writeError(
      args.response,
      401,
      "bilibili_login_required",
      "Bilibili authorization is required for this room video.",
    );
    return;
  }

  const info = {
    ...sourceInfo,
    title: sharedVideo.title,
    posterUrl: sharedVideo.posterUrl,
    duration: sharedVideo.duration,
  };
  try {
    const mediaSources = await resolveBilibiliMediaSources({
      info,
      cookie: authSession.cookie,
      fetchImpl: args.fetchImpl,
    });
    const mediaToken = args.createToken();
    const expiresAt = args.now() + BILIBILI_MEDIA_TOKEN_TTL_MS;
    args.state.mediaTokens.set(mediaToken, {
      url: mediaSources.primaryUrl,
      cookie: authSession.cookie,
      referer: info.normalizedUrl,
      expiresAt,
    });
    const deliveryMode = args.mediaDeliveryMode ?? "direct-first";
    args.mediaMetrics?.recordManifestIssued(
      deliveryMode,
      deliveryMode === "proxy-only" ? 0 : 1 + mediaSources.backupUrls.length,
    );
    writeJson(args.response, 200, {
      ok: true,
      data: {
        playbackSource: createBilibiliManifest({
          info,
          mediaSources,
          mediaToken,
          expiresAt,
          deliveryMode: args.mediaDeliveryMode,
          roomCode: args.roomCode,
          memberToken,
        }),
      },
    });
  } catch {
    writeError(
      args.response,
      400,
      "bilibili_source_expired",
      "Unable to refresh the Bilibili playback source.",
    );
  }
}

async function handleMediaProxy(args: {
  request: IncomingMessage;
  response: ServerResponse;
  mediaToken: string;
  roomService?: WebRoomService;
  state: WebRouteState;
  fetchImpl: BilibiliFetch;
  now: () => number;
  mediaMetrics?: WebRouteDependencies["mediaMetrics"];
}): Promise<void> {
  if (!args.roomService) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }
  if (args.request.method !== "GET") {
    writeError(args.response, 405, "method_not_allowed", "Method not allowed.");
    return;
  }

  const requestUrl = new URL(args.request.url ?? "/", "http://localhost");
  const roomCode = requestUrl.searchParams.get("roomCode");
  const memberToken = requestUrl.searchParams.get("memberToken");
  if (
    !roomCode ||
    !memberToken ||
    !(await args.roomService.isMemberTokenInRoom(roomCode, memberToken))
  ) {
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  const token = args.state.mediaTokens.get(args.mediaToken);
  if (!token || token.expiresAt <= args.now()) {
    args.state.mediaTokens.delete(args.mediaToken);
    writeError(args.response, 404, "not_found", "Not found.");
    return;
  }

  const headers = buildBilibiliHeaders(token.cookie, token.referer);
  const range = args.request.headers.range;
  if (typeof range === "string") {
    headers.range = range;
  }
  args.mediaMetrics?.recordProxyRequest();
  const upstream = await args.fetchImpl(token.url, { headers });
  if (!upstream.ok) {
    writeError(args.response, 502, "media_proxy_failed", "Media proxy failed.");
    return;
  }
  const declaredContentLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredContentLength) && declaredContentLength > 0) {
    args.mediaMetrics?.recordProxyBytes(declaredContentLength);
  }
  await pipeMediaProxyResponse({
    response: args.response,
    upstream,
  });
}

export async function tryHandleWebRoutes(args: {
  request: IncomingMessage;
  response: ServerResponse;
  pathname: string;
  roomService?: WebRoomService;
  now?: () => number;
  state?: WebRouteState;
  dependencies?: WebRouteDependencies;
}): Promise<boolean> {
  const state =
    args.state ??
    createWebRouteState({
      authSessionStore: args.dependencies?.authSessionStore,
    });
  const fetchImpl = args.dependencies?.fetch ?? defaultFetch;
  const createToken = args.dependencies?.createToken ?? defaultCreateToken;
  const now = args.now ?? Date.now;

  if (args.pathname === "/api/web/voice/token") {
    await handleVoiceToken({
      request: args.request,
      response: args.response,
      roomService: args.roomService,
      trtc: args.dependencies?.trtc,
    });
    return true;
  }

  if (args.pathname === "/api/web/auth/bilibili/login/start") {
    await handleBilibiliLoginStart({
      request: args.request,
      response: args.response,
      state,
      fetchImpl,
      now,
    });
    return true;
  }

  if (args.pathname === "/api/web/auth/bilibili/login/status") {
    await handleBilibiliLoginStatus({
      request: args.request,
      response: args.response,
      state,
      fetchImpl,
      createToken,
      now,
    });
    return true;
  }

  if (args.pathname === "/api/web/auth/bilibili/logout") {
    await handleBilibiliLogout({
      request: args.request,
      response: args.response,
      state,
      now,
    });
    return true;
  }

  if (args.pathname === "/api/web/video/resolve") {
    await handleVideoResolve({
      request: args.request,
      response: args.response,
      roomService: args.roomService,
      state,
      fetchImpl,
      createToken,
      mediaDeliveryMode: args.dependencies?.mediaDeliveryMode,
      mediaMetrics: args.dependencies?.mediaMetrics,
      now,
    });
    return true;
  }

  const mediaMatch = args.pathname.match(
    /^\/api\/web\/media\/([A-Za-z0-9_-]{16,128})\/video\.mp4$/,
  );
  if (mediaMatch) {
    await handleMediaProxy({
      request: args.request,
      response: args.response,
      mediaToken: mediaMatch[1],
      roomService: args.roomService,
      state,
      fetchImpl,
      mediaMetrics: args.dependencies?.mediaMetrics,
      now,
    });
    return true;
  }

  const playbackSourceMatch = args.pathname.match(
    /^\/api\/web\/rooms\/([A-Z0-9]{6})\/playback-source$/,
  );
  if (!playbackSourceMatch) {
    return false;
  }

  await handlePlaybackSource({
    request: args.request,
    response: args.response,
    roomCode: playbackSourceMatch[1],
    roomService: args.roomService,
    state,
    fetchImpl,
    createToken,
    mediaDeliveryMode: args.dependencies?.mediaDeliveryMode,
    mediaMetrics: args.dependencies?.mediaMetrics,
    now,
  });
  return true;
}
