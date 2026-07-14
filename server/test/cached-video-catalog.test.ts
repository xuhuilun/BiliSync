import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCachedVideoCatalog } from "../src/cached-videos/catalog.js";

async function createTempDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), name));
}

test("catalog recursively lists only completed MP4 files with stable public ids", async () => {
  const root = await createTempDirectory("bili-sync-cached-videos-");
  try {
    await mkdir(join(root, "series"));
    await writeFile(join(root, "movie.mp4"), "movie");
    await writeFile(join(root, "movie.mp4.part"), "partial");
    await writeFile(join(root, "notes.txt"), "notes");
    await writeFile(join(root, "series", "episode 01.MP4"), "episode");

    const catalog = createCachedVideoCatalog({
      directory: root,
      scanIntervalMs: 30_000,
    });
    await catalog.refresh();

    const first = catalog.list();
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((video) => video.title),
      ["movie", "episode 01"],
    );
    assert.ok(first.every((video) => video.id.startsWith("cv_")));
    assert.ok(
      first.every(
        (video) =>
          video.streamUrl === `/api/web/cached-videos/${video.id}/video.mp4`,
      ),
    );
    assert.ok(first.every((video) => !("realPath" in video)));

    await catalog.refresh();
    assert.deepEqual(
      catalog.list().map((video) => video.id),
      first.map((video) => video.id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog maps ids to internal files without exposing absolute paths", async () => {
  const root = await createTempDirectory("bili-sync-cached-video-entry-");
  try {
    const file = join(root, "film.mp4");
    await writeFile(file, "film");
    const catalog = createCachedVideoCatalog({
      directory: root,
      scanIntervalMs: 30_000,
    });
    await catalog.refresh();

    const [summary] = catalog.list();
    assert.ok(summary);
    assert.deepEqual(catalog.find(summary.id), {
      ...summary,
      relativePath: "film.mp4",
      realPath: file,
    });
    assert.equal(catalog.find("cv_unknown"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("catalog rejects symbolic links even when they point to an MP4", async (t) => {
  const root = await createTempDirectory("bili-sync-cached-video-link-");
  const outside = await createTempDirectory("bili-sync-outside-video-");
  try {
    const outsideFile = join(outside, "outside.mp4");
    await writeFile(outsideFile, "outside");
    try {
      await symlink(outsideFile, join(root, "linked.mp4"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("Creating symlinks requires elevated privileges on this host.");
        return;
      }
      throw error;
    }

    const catalog = createCachedVideoCatalog({
      directory: root,
      scanIntervalMs: 30_000,
    });
    await catalog.refresh();
    assert.deepEqual(catalog.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("catalog keeps the last successful snapshot when a later scan fails", async () => {
  const root = await createTempDirectory("bili-sync-cached-video-refresh-");
  try {
    await writeFile(join(root, "film.mp4"), "film");
    const errors: unknown[] = [];
    const catalog = createCachedVideoCatalog({
      directory: root,
      scanIntervalMs: 30_000,
      onError: (error) => errors.push(error),
    });
    await catalog.refresh();
    const snapshot = catalog.list();

    await rm(root, { recursive: true, force: true });
    await assert.rejects(catalog.refresh());
    assert.deepEqual(catalog.list(), snapshot);
    assert.equal(errors.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled catalog stays empty without touching the filesystem", async () => {
  const catalog = createCachedVideoCatalog({
    directory: undefined,
    scanIntervalMs: 30_000,
  });
  await catalog.refresh();
  assert.equal(catalog.enabled, false);
  assert.deepEqual(catalog.list(), []);
});
