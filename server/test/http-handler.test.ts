import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInMemoryRoomStore } from "../src/room-store.js";
import { createHttpRequestHandler } from "../src/bootstrap/http-handler.js";
import { createSecurityPolicy } from "../src/security.js";
import {
  createFileWebAuthSessionStore,
  type BilibiliFetch,
} from "../src/web-routes.js";

function createRequest(args: {
  url: string;
  method?: string;
  origin?: string | null;
  cookie?: string;
  range?: string;
  body?: string;
}) {
  return {
    url: args.url,
    method: args.method ?? "GET",
    headers: {
      ...(args.origin ? { origin: args.origin } : {}),
      ...(args.cookie ? { cookie: args.cookie } : {}),
      ...(args.range ? { range: args.range } : {}),
    },
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
  class TestResponse extends Writable {
    statusCode = 0;
    headers: Record<string, string> = {};
    body = "";
    headersSent = false;

    _write(
      chunk: Buffer | string,
      _encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
      callback();
    }

    writeHead(statusCode: number, headers: Record<string, string>) {
      if (this.headersSent) {
        throw new Error("ERR_HTTP_HEADERS_SENT");
      }
      this.headersSent = true;
      this.statusCode = statusCode;
      this.headers = headers;
      return this;
    }

    end(body?: string | Buffer) {
      if (body !== undefined) {
        this.body += Buffer.isBuffer(body) ? body.toString("utf8") : body;
      }
      super.end();
      return this;
    }
  }

  return new TestResponse() as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
  };
}

function jsonFetch(payload: unknown): Awaited<ReturnType<BilibiliFetch>> {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => payload,
    arrayBuffer: async () => Buffer.from(JSON.stringify(payload)).buffer,
  };
}

function bytesFetch(
  body: string,
  contentType = "video/mp4",
): Awaited<ReturnType<BilibiliFetch>> {
  const buffer = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(buffer);
        controller.close();
      },
    }),
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: async () => JSON.parse(body),
    arrayBuffer: async () =>
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
  };
}

function qrGenerateFetch(
  qrcodeKey = "qr-key-123",
): Awaited<ReturnType<BilibiliFetch>> {
  return jsonFetch({
    code: 0,
    data: {
      url: `https://passport.bilibili.com/qrcode-login?key=${qrcodeKey}`,
      qrcode_key: qrcodeKey,
    },
  });
}

function qrPollSuccessFetch(): Awaited<ReturnType<BilibiliFetch>> {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "set-cookie"
          ? "SESSDATA=abc; Path=/; HttpOnly, bili_jct=csrf; Path=/"
          : null,
    },
    json: async () => ({
      code: 0,
      data: {
        code: 0,
        message: "success",
      },
    }),
    arrayBuffer: async () => Buffer.from("{}").buffer,
  };
}

async function completeQrLogin(
  handler: ReturnType<typeof createHttpRequestHandler>,
  qrcodeKey = "qr-key-123",
): Promise<void> {
  const loginResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/auth/bilibili/login/start",
      method: "POST",
      origin: "chrome-extension://allowed",
    }),
    loginResponse,
  );
  const statusResponse = createResponse();
  await handler(
    createRequest({
      url: `/api/web/auth/bilibili/login/status?qrcodeKey=${qrcodeKey}`,
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    statusResponse,
  );
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

test("web bilibili auth reports missing login before a cookie is imported", async () => {
  const { handler } = createHandler();
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/auth/bilibili/login/status",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    data: {
      loggedIn: false,
    },
  });
});

test("web bilibili QR login stores authorized cookie server-side", async () => {
  const fetchCalls: Array<{ url: string; cookie?: string }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      createToken: () => "auth-session-token-123",
      fetch: async (url, init) => {
        fetchCalls.push({
          url,
          cookie: init?.headers?.cookie,
        });
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return jsonFetch({
            code: 0,
            data: {
              url: "https://passport.bilibili.com/qrcode-login?oauthKey=qr",
              qrcode_key: "qr-key-123",
            },
          });
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return {
            ok: true,
            status: 200,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "set-cookie"
                  ? "SESSDATA=abc; Path=/; HttpOnly, bili_jct=csrf; Path=/"
                  : null,
            },
            json: async () => ({
              code: 0,
              data: {
                code: 0,
                message: "success",
              },
            }),
            arrayBuffer: async () => Buffer.from("{}").buffer,
          };
        }
        return jsonFetch({
          code: 0,
          data: {
            isLogin: true,
            uname: "Alice",
            face: "https://i0.hdslb.com/bfs/face/alice.jpg",
          },
        });
      },
    },
  });
  const startResponse = createResponse();

  await handler(
    createRequest({
      url: "/api/web/auth/bilibili/login/start",
      method: "POST",
      origin: "chrome-extension://allowed",
    }),
    startResponse,
  );

  assert.equal(startResponse.statusCode, 200);
  assert.deepEqual(JSON.parse(startResponse.body), {
    ok: true,
    data: {
      loginUrl: "https://passport.bilibili.com/qrcode-login?oauthKey=qr",
      qrcodeKey: "qr-key-123",
      expiresInSeconds: 180,
    },
  });

  const statusResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/auth/bilibili/login/status?qrcodeKey=qr-key-123",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    statusResponse,
  );

  assert.equal(statusResponse.statusCode, 200);
  assert.match(
    statusResponse.headers["set-cookie"],
    /^bili_sync_auth=auth-session-token-123;/,
  );
  assert.deepEqual(JSON.parse(statusResponse.body), {
    ok: true,
    data: {
      loggedIn: true,
      displayName: "Alice",
      avatarUrl: "https://i0.hdslb.com/bfs/face/alice.jpg",
      qrStatus: "succeeded",
    },
  });
  assert.ok(
    fetchCalls.some((call) =>
      call.url.includes("/x/passport-login/web/qrcode/generate"),
    ),
  );
  assert.ok(
    fetchCalls.some((call) =>
      call.url.includes("/x/passport-login/web/qrcode/poll"),
    ),
  );
  assert.ok(
    fetchCalls.some(
      (call) =>
        call.url.includes("/x/web-interface/nav") &&
        call.cookie === "SESSDATA=abc; bili_jct=csrf",
    ),
  );
});

test("web bilibili auth session survives a fresh server handler through the persisted cookie token", async () => {
  const authRoot = await mkdtemp(join(tmpdir(), "bili-sync-auth-"));
  const authStore = createFileWebAuthSessionStore(join(authRoot, "auth.json"));
  const fetchImpl: BilibiliFetch = async (url, init) => {
    if (url.includes("/x/passport-login/web/qrcode/generate")) {
      return qrGenerateFetch();
    }
    if (url.includes("/x/passport-login/web/qrcode/poll")) {
      return qrPollSuccessFetch();
    }
    assert.equal(init?.headers?.cookie, "SESSDATA=abc; bili_jct=csrf");
    return jsonFetch({
      code: 0,
      data: {
        isLogin: true,
        uname: "Alice",
        face: "https://i0.hdslb.com/bfs/face/alice.jpg",
      },
    });
  };
  const createPersistentHandler = () =>
    createHttpRequestHandler({
      adminRouter: {
        handle: async () => false,
      },
      securityPolicy: createSecurityPolicy({
        allowedOrigins: ["chrome-extension://allowed"],
        allowMissingOriginInDev: false,
        connectionAttemptsPerMinute: 10,
        maxConnectionsPerIp: 5,
        maxMembersPerRoom: 2,
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
      webRouteDependencies: {
        authSessionStore: authStore,
        createToken: () => "auth-token-123456",
        fetch: fetchImpl,
      },
    });

  try {
    await completeQrLogin(createPersistentHandler());

    const restoredResponse = createResponse();
    await createPersistentHandler()(
      createRequest({
        url: "/api/web/auth/bilibili/login/status",
        method: "GET",
        origin: "chrome-extension://allowed",
        cookie: "bili_sync_auth=auth-token-123456",
      }),
      restoredResponse,
    );

    assert.equal(restoredResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(restoredResponse.body), {
      ok: true,
      data: {
        loggedIn: true,
        displayName: "Alice",
        avatarUrl: "https://i0.hdslb.com/bfs/face/alice.jpg",
      },
    });

    const logoutResponse = createResponse();
    await createPersistentHandler()(
      createRequest({
        url: "/api/web/auth/bilibili/logout",
        method: "POST",
        origin: "chrome-extension://allowed",
        cookie: "bili_sync_auth=auth-token-123456",
      }),
      logoutResponse,
    );
    assert.equal(logoutResponse.statusCode, 200);

    const afterLogoutResponse = createResponse();
    await createPersistentHandler()(
      createRequest({
        url: "/api/web/auth/bilibili/login/status",
        method: "GET",
        origin: "chrome-extension://allowed",
        cookie: "bili_sync_auth=auth-token-123456",
      }),
      afterLogoutResponse,
    );
    assert.equal(afterLogoutResponse.statusCode, 200);
    assert.deepEqual(JSON.parse(afterLogoutResponse.body), {
      ok: true,
      data: {
        loggedIn: false,
      },
    });
  } finally {
    await rm(authRoot, { recursive: true, force: true });
  }
});

test("web bilibili resolve returns direct, backup, and proxy playback candidates", async () => {
  const fetchCalls: string[] = [];
  const manifestMetrics: Array<{
    mode: string;
    directCandidateCount: number;
  }> = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      mediaMetrics: {
        recordManifestIssued: (mode, directCandidateCount) =>
          manifestMetrics.push({ mode, directCandidateCount }),
        recordProxyRequest: () => undefined,
        recordProxyBytes: () => undefined,
        recordProxyUpstreamAttempt: () => undefined,
      },
      createToken: (() => {
        const tokens = [
          "auth-token-123456",
          "unauthorized-media-token",
          "media-token-123456",
        ];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        fetchCalls.push(url);
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: {
              isLogin: true,
              uname: "Alice",
            },
          });
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1xx411c7mD",
              aid: 123,
              cid: 456,
              title: "Movie Night",
              pic: "https://i0.hdslb.com/bfs/archive/poster.jpg",
              duration: 100,
            },
          });
        }
        return jsonFetch({
          code: 0,
          data: {
            durl: [
              {
                url: "https://upos.example.test/video.mp4",
                backup_url: [
                  "https://backup.example.test/video.mp4",
                  "javascript:alert(1)",
                  "https://upos.example.test/video.mp4",
                ],
              },
            ],
          },
        });
      },
    },
    webRoomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async (roomCode, memberToken) =>
        roomCode === "ABC123" && memberToken === "member-token",
      resolveMemberIdByToken: async () => null,
    },
  });
  await completeQrLogin(handler);
  const unauthorizedResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "BV1xx411c7mD" }),
    }),
    unauthorizedResponse,
  );
  const unauthorizedPayload = JSON.parse(unauthorizedResponse.body);
  assert.equal(unauthorizedPayload.data.playbackSource.variants.length, 1);
  assert.match(
    unauthorizedPayload.data.playbackSource.variants[0].url,
    /^\/api\/web\/media\/unauthorized-media-token\/video\.mp4$/,
  );
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({
        input: "BV1xx411c7mD",
        roomCode: "ABC123",
        memberToken: "member-token",
      }),
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.video.sourceProvider, "authorized-bilibili");
  assert.equal(payload.data.video.videoId, "BV1xx411c7mD:456");
  assert.equal(payload.data.video.title, "Movie Night");
  assert.deepEqual(payload.data.playbackSource.variants.slice(0, 2), [
    {
      kind: "mp4",
      url: "https://upos.example.test/video.mp4",
      mimeType: "video/mp4",
      label: "B站 CDN",
    },
    {
      kind: "mp4",
      url: "https://backup.example.test/video.mp4",
      mimeType: "video/mp4",
      label: "B站备用 CDN 1",
    },
  ]);
  assert.match(
    payload.data.playbackSource.variants[2].url,
    /^\/api\/web\/media\/media-token-123456\/video\.mp4$/,
  );
  assert.equal(payload.data.playbackSource.variants[2].label, "服务器代理");
  assert.equal(payload.data.playbackSource.variants.length, 3);
  assert.deepEqual(manifestMetrics, [
    { mode: "proxy-only", directCandidateCount: 0 },
    { mode: "direct-first", directCandidateCount: 2 },
  ]);
  assert.equal(response.body.includes("SESSDATA"), false);
  assert.ok(fetchCalls.some((url) => url.includes("bvid=BV1xx411c7mD")));
});

test("web bilibili resolve expands b23 short links before resolving playback source", async () => {
  const fetchCalls: string[] = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-short"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        fetchCalls.push(url);
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url === "https://b23.tv/abc123") {
          return {
            ok: true,
            status: 302,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === "location"
                  ? "https://www.bilibili.com/video/BV1Xs421N7Gr/?share_source=copy_web"
                  : null,
            },
            json: async () => ({}),
            arrayBuffer: async () => Buffer.from("").buffer,
          };
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1Xs421N7Gr",
              aid: 46050491,
              cid: 987,
              title: "Short Link Movie",
            },
          });
        }
        return jsonFetch({
          code: 0,
          data: {
            durl: [{ url: "https://upos.example.test/short.mp4" }],
          },
        });
      },
    },
  });
  await completeQrLogin(handler);
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "https://b23.tv/abc123" }),
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.video.videoId, "BV1Xs421N7Gr:987");
  assert.equal(
    payload.data.video.url,
    "https://www.bilibili.com/video/BV1Xs421N7Gr",
  );
  assert.ok(fetchCalls.includes("https://b23.tv/abc123"));
  assert.ok(fetchCalls.some((url) => url.includes("bvid=BV1Xs421N7Gr")));
});

test("web bilibili resolve accepts bangumi episode links", async () => {
  const fetchCalls: string[] = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      mediaDeliveryMode: "proxy-only",
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-ep"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        fetchCalls.push(url);
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url.includes("/pgc/view/web/season")) {
          return jsonFetch({
            code: 0,
            result: {
              season_title: "番剧标题",
              episodes: [
                {
                  id: 600001,
                  aid: 789,
                  bvid: "BV1Pg411x7xX",
                  cid: 222,
                  title: "第1话",
                  long_title: "开始",
                  cover: "https://i0.hdslb.com/bfs/archive/ep.jpg",
                  duration: 240000,
                },
              ],
            },
          });
        }
        return jsonFetch({
          code: 0,
          data: {
            durl: [{ url: "https://upos.example.test/ep.mp4" }],
          },
        });
      },
    },
  });
  await completeQrLogin(handler);
  const response = createResponse();

  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({
        input: "https://www.bilibili.com/bangumi/play/ep600001",
      }),
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  const payload = JSON.parse(response.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.video.videoId, "ep600001:222");
  assert.equal(payload.data.video.title, "番剧标题 第1话 开始");
  assert.equal(payload.data.video.sourceRef, "ep600001:222");
  assert.match(
    payload.data.playbackSource.variants[0].url,
    /^\/api\/web\/media\/media-token-ep\/video\.mp4$/,
  );
  assert.ok(
    fetchCalls.some(
      (url) =>
        url.includes("/pgc/player/web/playurl") &&
        url.includes("ep_id=600001") &&
        url.includes("cid=222"),
    ),
  );
});

test("web bilibili resolve returns explicit errors for empty and unsupported input", async () => {
  const { handler } = createHandler();

  const emptyResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      body: JSON.stringify({ input: "" }),
    }),
    emptyResponse,
  );

  assert.equal(emptyResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(emptyResponse.body), {
    ok: false,
    error: {
      code: "empty_video_link",
      message: "请先粘贴视频链接。",
    },
  });

  const unsupportedResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      body: JSON.stringify({ input: "https://example.com/watch/1" }),
    }),
    unsupportedResponse,
  );

  assert.equal(unsupportedResponse.statusCode, 400);
  assert.deepEqual(JSON.parse(unsupportedResponse.body), {
    ok: false,
    error: {
      code: "unsupported_bilibili_link",
      message: "暂不支持该链接格式，请检查后重试。",
    },
  });
});

test("web bilibili media proxy requires a current room member token", async () => {
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-123456"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1xx411c7mD",
              aid: 123,
              cid: 456,
              title: "Movie Night",
            },
          });
        }
        return jsonFetch({
          code: 0,
          data: { durl: [{ url: "https://upos.example.test/video.mp4" }] },
        });
      },
    },
    webRoomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async () => false,
    },
  });
  await completeQrLogin(handler);
  const resolveResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "BV1xx411c7mD" }),
    }),
    resolveResponse,
  );

  const response = createResponse();
  await handler(
    createRequest({
      url: "/api/web/media/media-token-123456/video.mp4?roomCode=ABC123&memberToken=bad-token",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 404);
});

test("web bilibili media proxy streams bytes for current room members", async () => {
  const fetchedMediaUrls: string[] = [];
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-123456"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1xx411c7mD",
              aid: 123,
              cid: 456,
              title: "Movie Night",
            },
          });
        }
        if (url.includes("/x/player/playurl")) {
          return jsonFetch({
            code: 0,
            data: { durl: [{ url: "https://upos.example.test/video.mp4" }] },
          });
        }
        fetchedMediaUrls.push(url);
        return bytesFetch("video-bytes");
      },
    },
    webRoomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async (roomCode, memberToken) =>
        roomCode === "ABC123" && memberToken === "member-token",
    },
  });
  await completeQrLogin(handler);
  const resolveResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "BV1xx411c7mD" }),
    }),
    resolveResponse,
  );

  const response = createResponse();
  await handler(
    createRequest({
      url: "/api/web/media/media-token-123456/video.mp4?roomCode=ABC123&memberToken=member-token",
      method: "GET",
      origin: "chrome-extension://allowed",
    }),
    response,
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.body, "video-bytes");
  assert.deepEqual(fetchedMediaUrls, ["https://upos.example.test/video.mp4"]);
});

test("web bilibili media proxy forwards range requests and streams partial content", async () => {
  const mediaFetchCalls: Array<{ url: string; range?: string }> = [];
  let proxyRequestCount = 0;
  let proxyBytes = 0;
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      mediaMetrics: {
        recordManifestIssued: () => undefined,
        recordProxyRequest: () => {
          proxyRequestCount += 1;
        },
        recordProxyBytes: (bytes) => {
          proxyBytes += bytes;
        },
        recordProxyUpstreamAttempt: () => undefined,
      },
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-123456"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url, init) => {
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1xx411c7mD",
              aid: 123,
              cid: 456,
              title: "Movie Night",
            },
          });
        }
        if (url.includes("/x/player/playurl")) {
          return jsonFetch({
            code: 0,
            data: { durl: [{ url: "https://upos.example.test/video.mp4" }] },
          });
        }
        mediaFetchCalls.push({
          url,
          range: init?.headers?.range,
        });
        const body = Buffer.from("part");
        return {
          ok: true,
          status: 206,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.close();
            },
          }),
          headers: {
            get: (name: string) => {
              switch (name.toLowerCase()) {
                case "content-type":
                  return "video/mp4";
                case "content-length":
                  return "4";
                case "content-range":
                  return "bytes 0-3/100";
                case "accept-ranges":
                  return "bytes";
                default:
                  return null;
              }
            },
          },
          json: async () => ({}),
          arrayBuffer: async () =>
            body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength,
            ),
        };
      },
    },
    webRoomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async (roomCode, memberToken) =>
        roomCode === "ABC123" && memberToken === "member-token",
    },
  });
  await completeQrLogin(handler);
  const resolveResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "BV1xx411c7mD" }),
    }),
    resolveResponse,
  );

  const response = createResponse();
  await handler(
    createRequest({
      url: "/api/web/media/media-token-123456/video.mp4?roomCode=ABC123&memberToken=member-token",
      method: "GET",
      origin: "chrome-extension://allowed",
      range: "bytes=0-3",
    }),
    response,
  );

  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.headers["content-length"], "4");
  assert.equal(response.headers["content-range"], "bytes 0-3/100");
  assert.equal(response.headers["accept-ranges"], "bytes");
  assert.equal(response.body, "part");
  assert.deepEqual(mediaFetchCalls, [
    {
      url: "https://upos.example.test/video.mp4",
      range: "bytes=0-3",
    },
  ]);
  assert.equal(proxyRequestCount, 1);
  assert.equal(proxyBytes, 4);
});

test("web bilibili media proxy does not send a second response when streaming fails after headers", async () => {
  const handler = createHttpRequestHandler({
    adminRouter: {
      handle: async () => false,
    },
    securityPolicy: createSecurityPolicy({
      allowedOrigins: ["chrome-extension://allowed"],
      allowMissingOriginInDev: false,
      connectionAttemptsPerMinute: 10,
      maxConnectionsPerIp: 5,
      maxMembersPerRoom: 2,
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
    webRouteDependencies: {
      createToken: (() => {
        const tokens = ["auth-token-123456", "media-token-123456"];
        return () => tokens.shift() ?? "fallback-token-123";
      })(),
      fetch: async (url) => {
        if (url.includes("/x/passport-login/web/qrcode/generate")) {
          return qrGenerateFetch();
        }
        if (url.includes("/x/passport-login/web/qrcode/poll")) {
          return qrPollSuccessFetch();
        }
        if (url.includes("/x/web-interface/nav")) {
          return jsonFetch({
            code: 0,
            data: { isLogin: true, uname: "Alice" },
          });
        }
        if (url.includes("/x/web-interface/view")) {
          return jsonFetch({
            code: 0,
            data: {
              bvid: "BV1xx411c7mD",
              aid: 123,
              cid: 456,
              title: "Movie Night",
            },
          });
        }
        if (url.includes("/x/player/playurl")) {
          return jsonFetch({
            code: 0,
            data: { durl: [{ url: "https://upos.example.test/video.mp4" }] },
          });
        }
        const body = Buffer.from("partial");
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(body);
              controller.error(new Error("upstream stream failed"));
            },
          }),
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "video/mp4" : null,
          },
          json: async () => ({}),
          arrayBuffer: async () =>
            body.buffer.slice(
              body.byteOffset,
              body.byteOffset + body.byteLength,
            ),
        };
      },
    },
    webRoomService: {
      getRoom: async () => null,
      isMemberTokenInRoom: async (roomCode, memberToken) =>
        roomCode === "ABC123" && memberToken === "member-token",
    },
  });
  await completeQrLogin(handler);
  const resolveResponse = createResponse();
  await handler(
    createRequest({
      url: "/api/web/video/resolve",
      method: "POST",
      origin: "chrome-extension://allowed",
      cookie: "bili_sync_auth=auth-token-123456",
      body: JSON.stringify({ input: "BV1xx411c7mD" }),
    }),
    resolveResponse,
  );

  const response = createResponse();
  await assert.doesNotReject(() =>
    handler(
      createRequest({
        url: "/api/web/media/media-token-123456/video.mp4?roomCode=ABC123&memberToken=member-token",
        method: "GET",
        origin: "chrome-extension://allowed",
      }),
      response,
    ),
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.body.includes("internal_error"), false);
  assert.equal(response.destroyed, true);
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
        Promise.resolve(
          roomCode === "ABC123" && memberToken === "member-token",
        ),
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
