import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createHttpRequestHandler } from "../src/bootstrap/http-handler.js";
import { createSecurityPolicy } from "../src/security.js";

function createRequest(args: {
  url: string;
  method?: string;
  origin?: string | null;
  body?: string;
}) {
  return {
    url: args.url,
    method: args.method ?? "GET",
    headers: args.origin ? { origin: args.origin } : {},
    socket: {
      remoteAddress: "127.0.0.1",
    },
    [Symbol.asyncIterator]: async function* () {
      if (args.body !== undefined) {
        yield Buffer.from(args.body);
      }
    },
  } as IncomingMessage;
}

function createResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: "",
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    },
    end(body?: string) {
      this.body = body ?? "";
      return this;
    },
  } as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
}

function createHandler(adminHandled = false) {
  const adminCalls: Array<{ url?: string; method?: string }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async (request, response) => {
        adminCalls.push({
          url: request.url,
          method: request.method,
        });
        if (!adminHandled) {
          return false;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, admin: true }));
        return true;
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
  });

  return { handler, adminCalls };
}

test("http handler reflects allowed origin on connection-check preflight", () => {
  const { handler, adminCalls } = createHandler();

  const preflightResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "OPTIONS",
      origin: "chrome-extension://allowed",
    }),
    preflightResponse,
  );
  assert.equal(preflightResponse.statusCode, 204);
  assert.equal(
    preflightResponse.headers["access-control-allow-origin"],
    "chrome-extension://allowed",
  );
  assert.equal(preflightResponse.headers["vary"], "origin");
  assert.equal(adminCalls.length, 0);
});

test("http handler reports websocketAllowed without leaking reason or CORS to disallowed origins", () => {
  const { handler, adminCalls } = createHandler();

  const allowedResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    allowedResponse,
  );
  assert.equal(allowedResponse.statusCode, 200);
  assert.equal(
    allowedResponse.headers["access-control-allow-origin"],
    "chrome-extension://allowed",
  );
  assert.equal(allowedResponse.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(allowedResponse.body), {
    ok: true,
    data: {
      websocketAllowed: true,
    },
  });

  const deniedResponse = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
      origin: "chrome-extension://denied",
    }),
    deniedResponse,
  );
  assert.equal(deniedResponse.statusCode, 200);
  assert.equal(
    deniedResponse.headers["access-control-allow-origin"],
    undefined,
  );
  assert.equal(deniedResponse.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(deniedResponse.body), {
    ok: true,
    data: {
      websocketAllowed: false,
    },
  });
  assert.equal(adminCalls.length, 0);
});

test("http handler omits CORS headers when origin is missing", () => {
  const { handler } = createHandler();

  const response = createResponse();
  handler(
    createRequest({
      url: "/api/connection-check",
      method: "GET",
    }),
    response,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["vary"], "origin");
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: {
      websocketAllowed: false,
    },
  });
});

test("http handler returns 404 for /metrics when metrics are routed to a dedicated port", async () => {
  const adminCalls: Array<{ url?: string }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async (request) => {
        adminCalls.push({ url: request.url });
        return false;
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
    metricsEnabled: false,
  });

  const response = createResponse();
  await handler(createRequest({ url: "/metrics" }), response);

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: {
      code: "not_found",
      message: "Not found.",
    },
  });
  assert.equal(adminCalls.length, 0);
});

test("http handler preserves admin router responses without falling through to root payload", async () => {
  const { handler, adminCalls } = createHandler(true);
  const response = createResponse();

  handler(
    createRequest({
      url: "/api/admin/me",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(adminCalls.length, 1);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    admin: true,
  });
});

test("http handler returns a stable 500 payload when downstream routing throws", async () => {
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => {
        throw new Error("boom");
      },
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
  });
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/admin/me",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 500);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: {
      code: "internal_error",
      message: "Internal server error.",
    },
  });
});

test("web video resolve accepts direct HLS urls as shareable videos", async () => {
  const { handler } = createHandler();
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      body: JSON.stringify({
        url: "https://cdn.example.test/movie/master.m3u8?token=abc",
        title: "Movie Night",
      }),
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: {
      video: {
        videoId: "direct:movie-master-m3u8",
        url: "https://cdn.example.test/movie/master.m3u8?token=abc",
        title: "Movie Night",
        sourceProvider: "direct",
        sourceRef: "https://cdn.example.test/movie/master.m3u8",
      },
      playbackSource: {
        videoId: "direct:movie-master-m3u8",
        title: "Movie Night",
        expiresAt: 0,
        variants: [
          {
            kind: "hls",
            url: "https://cdn.example.test/movie/master.m3u8?token=abc",
            mimeType: "application/vnd.apple.mpegurl",
            label: "HLS",
          },
        ],
      },
    },
  });
});

test("web playback source requires a current room member token", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const room = await roomStore.createRoom({
    code: "ABC123",
    joinToken: "join-token",
    createdAt: 1_000,
  });
  await roomStore.updateRoom(room.code, room.version, {
    sharedVideo: {
      videoId: "direct:movie-master-m3u8",
      url: "https://cdn.example.test/movie/master.m3u8",
      title: "Movie Night",
      sourceProvider: "direct",
      sourceRef: "https://cdn.example.test/movie/master.m3u8",
    },
    playback: null,
  });
  const { handler } = createHandler();
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/rooms/ABC123/playback-source?memberToken=bad-token",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), {
    ok: false,
    error: {
      code: "not_found",
      message: "Not found.",
    },
  });
});

test("web playback source returns direct manifest for joined room members", async () => {
  const roomStore = createInMemoryRoomStore({ now: () => 1_000 });
  const createdRoom = await roomStore.createRoom({
    code: "ABC123",
    joinToken: "join-token",
    createdAt: 1_000,
  });
  await roomStore.updateRoom(createdRoom.code, createdRoom.version, {
    sharedVideo: {
      videoId: "direct:clip-mp4",
      url: "https://cdn.example.test/clip.mp4#t=0",
      title: "Clip",
      sourceProvider: "direct",
      sourceRef: "https://cdn.example.test/clip.mp4",
      posterUrl: "https://cdn.example.test/poster.jpg",
    },
    playback: null,
  });
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
    webRoomService: {
      getRoom: (roomCode) => roomStore.getRoom(roomCode),
      isMemberTokenInRoom: (roomCode, memberToken) =>
        Promise.resolve(roomCode === "ABC123" && memberToken === "member-token"),
    },
    now: () => 10_000,
  });
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/rooms/ABC123/playback-source?memberToken=member-token",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: {
      playbackSource: {
        videoId: "direct:clip-mp4",
        title: "Clip",
        expiresAt: 1_210_000,
        posterUrl: "https://cdn.example.test/poster.jpg",
        variants: [
          {
            kind: "mp4",
            url: "https://cdn.example.test/clip.mp4#t=0",
            mimeType: "video/mp4",
            label: "MP4",
          },
        ],
      },
    },
  });
});

test("http handler serves built web app from root paths", async () => {
  const webRoot = await mkdtemp(join(tmpdir(), "bili-sync-web-"));
  await writeFile(join(webRoot, "index.html"), "<main>BiliSync Web</main>");
  await writeFile(join(webRoot, "app.js"), "console.log('web');");
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 8,
      trustedProxyAddresses: [],
      rateLimits: {
        roomCreatePerMinute: 5,
        roomJoinPerMinute: 10,
        videoSharePerMinute: 20,
        playbackUpdatePerSecond: 30,
        profileUpdatePerMinute: 20,
        syncPingPerMinute: 30,
        syncPingBurst: 5,
      },
    }),
    webUiConfig: {
      enabled: true,
      rootDir: webRoot,
    },
  });

  try {
    const indexResponse = createResponse();
    await handler(createRequest({ url: "/", method: "GET" }), indexResponse);
    assert.equal(indexResponse.statusCode, 200);
    assert.equal(
      indexResponse.headers["content-type"],
      "text/html; charset=utf-8",
    );
    assert.equal(indexResponse.body, "<main>BiliSync Web</main>");

    const assetResponse = createResponse();
    await handler(
      createRequest({ url: "/app.js", method: "GET" }),
      assetResponse,
    );
    assert.equal(assetResponse.statusCode, 200);
    assert.equal(
      assetResponse.headers["content-type"],
      "text/javascript; charset=utf-8",
    );
    assert.equal(assetResponse.body, "console.log('web');");
  } finally {
    await rm(webRoot, { recursive: true, force: true });
  }
});
