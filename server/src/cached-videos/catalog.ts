import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";

export type CachedVideoSummary = {
  id: string;
  title: string;
  streamUrl: string;
  size: number;
  updatedAt: number;
  status: "ready";
};

export type CachedVideoEntry = CachedVideoSummary & {
  relativePath: string;
  realPath: string;
};

export type CachedVideoCatalog = {
  readonly enabled: boolean;
  refresh: () => Promise<void>;
  list: () => CachedVideoSummary[];
  find: (id: string) => CachedVideoEntry | null;
  start: () => void;
  stop: () => void;
};

type CatalogOptions = {
  directory: string | undefined;
  scanIntervalMs: number;
  onError?: (error: unknown) => void;
};

function isInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function createVideoId(relativePath: string): string {
  const normalizedPath = relativePath.split(sep).join("/");
  const digest = createHash("sha256")
    .update(normalizedPath)
    .digest("base64url")
    .slice(0, 24);
  return `cv_${digest}`;
}

async function scanDirectory(
  rootPath: string,
  directoryPath: string,
  entries: CachedVideoEntry[],
): Promise<void> {
  const children = await readdir(directoryPath, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    if (child.isSymbolicLink()) {
      continue;
    }
    const candidatePath = join(directoryPath, child.name);
    if (child.isDirectory()) {
      await scanDirectory(rootPath, candidatePath, entries);
      continue;
    }
    if (!child.isFile() || extname(child.name).toLowerCase() !== ".mp4") {
      continue;
    }

    const fileInfo = await lstat(candidatePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      continue;
    }
    const resolvedPath = await realpath(candidatePath);
    if (!isInsideRoot(rootPath, resolvedPath)) {
      continue;
    }
    const relativePath = relative(rootPath, resolvedPath);
    const id = createVideoId(relativePath);
    const currentStat = await stat(resolvedPath);
    entries.push({
      id,
      title: basename(child.name, extname(child.name)),
      streamUrl: `/api/web/cached-videos/${id}/video.mp4`,
      size: currentStat.size,
      updatedAt: currentStat.mtimeMs,
      status: "ready",
      relativePath,
      realPath: resolvedPath,
    });
  }
}

async function scanCachedVideos(
  directory: string,
): Promise<CachedVideoEntry[]> {
  const rootPath = await realpath(directory);
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error("Cached video directory is not a directory.");
  }
  const entries: CachedVideoEntry[] = [];
  await scanDirectory(rootPath, rootPath, entries);
  return entries;
}

export function createCachedVideoCatalog(
  options: CatalogOptions,
): CachedVideoCatalog {
  let entriesById = new Map<string, CachedVideoEntry>();
  let timer: NodeJS.Timeout | undefined;

  const refresh = async (): Promise<void> => {
    if (!options.directory) {
      entriesById = new Map();
      return;
    }
    try {
      const scannedEntries = await scanCachedVideos(options.directory);
      entriesById = new Map(
        scannedEntries.map((entry) => [entry.id, entry] as const),
      );
    } catch (error) {
      options.onError?.(error);
      throw error;
    }
  };

  return {
    enabled: options.directory !== undefined,
    refresh,
    list: () =>
      Array.from(entriesById.values()).map(
        ({ relativePath: _relativePath, realPath: _realPath, ...summary }) =>
          summary,
      ),
    find: (id) => entriesById.get(id) ?? null,
    start: () => {
      if (!options.directory || timer) {
        return;
      }
      void refresh().catch(() => undefined);
      timer = setInterval(() => {
        void refresh().catch(() => undefined);
      }, options.scanIntervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
