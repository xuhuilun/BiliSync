import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createHttpRequestHandler } from "../src/bootstrap/http-handler.js";
import { getDefaultSecurityConfig } from "../src/bootstrap/server-bootstrap.js";
import type {
  CachedVideoCatalog,
  CachedVideoEntry,
} from "../src/cached-videos/catalog.js";
import { createSecurityPolicy } from "../src/security.js";

const summary = {
  id: "cv_test",
  title: "Test movie",
  streamUrl: "/api/web/cached-videos/cv_test/video.mp4",
  size: 1234,
  updatedAt: 1_784_000_000_000,
  status: "ready" as const,
};

function createCatalog(entry: CachedVideoEntry | null): CachedVideoCatalog {
  return {
    enabled: true,
    refresh: async () => undefined,
    list: () => [summary],
    find: (id) => (id === summary.id ? entry : null),
    start: () => undefined,
    stop: () => undefined,
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP address.");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function withServer(
  catalog: CachedVideoCatalog | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const securityPolicy = createSecurityPolicy(getDefaultSecurityConfig());
  const server = createServer(
    createHttpRequestHandler({
      adminRouter: { handle: async () => false },
      securityPolicy,
      adminUiConfig: { enabled: false },
      webRouteDependencies: { cachedVideoCatalog: catalog },
    }),
  );
  const baseUrl = await listen(server);
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("cached video list returns public metadata without internal paths", async () => {
  const entry: CachedVideoEntry = {
    ...summary,
    relativePath: "series/Test movie.mp4",
    realPath: "/opt/bilisync/media/series/Test movie.mp4",
  };
  await withServer(createCatalog(entry), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/web/cached-videos`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      ok: true,
      data: { enabled: true, videos: [summary] },
    });
  });
});

test("cached video list reports the feature as disabled when unconfigured", async () => {
  await withServer(undefined, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/web/cached-videos`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      data: { enabled: false, videos: [] },
    });
  });
});

test("cached video playback delegates the validated file to Nginx", async () => {
  const entry: CachedVideoEntry = {
    ...summary,
    relativePath: "series/Test movie.mp4",
    realPath: "/opt/bilisync/media/series/Test movie.mp4",
  };
  await withServer(createCatalog(entry), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/web/cached-videos/${summary.id}/video.mp4`,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.equal(
      response.headers.get("x-accel-redirect"),
      "/_cached-media/series/Test%20movie.mp4",
    );
    assert.equal(await response.text(), "");
  });
});

test("cached video playback rejects unknown ids and unsafe catalog paths", async () => {
  const unsafeEntry: CachedVideoEntry = {
    ...summary,
    relativePath: "../secret.mp4",
    realPath: "/opt/bilisync/secret.mp4",
  };
  await withServer(createCatalog(unsafeEntry), async (baseUrl) => {
    const unknown = await fetch(
      `${baseUrl}/api/web/cached-videos/cv_unknown/video.mp4`,
    );
    assert.equal(unknown.status, 404);

    const unsafe = await fetch(
      `${baseUrl}/api/web/cached-videos/${summary.id}/video.mp4`,
    );
    assert.equal(unsafe.status, 404);
    assert.equal(unsafe.headers.get("x-accel-redirect"), null);
  });
});
