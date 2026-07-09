import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const defaultWebUiDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);

const assetTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

export type WebUiConfig = {
  enabled?: boolean;
  rootDir?: string;
};

function isReservedPath(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/readyz" ||
    pathname === "/metrics" ||
    pathname.startsWith("/api/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}

export async function tryHandleWebPanel(
  request: IncomingMessage,
  response: ServerResponse,
  config: WebUiConfig = {},
): Promise<boolean> {
  if (config.enabled === false) {
    return false;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  if (isReservedPath(url.pathname)) {
    return false;
  }

  const webUiDir = path.resolve(config.rootDir ?? defaultWebUiDir);
  const relativePath =
    url.pathname === "/"
      ? "index.html"
      : decodeURIComponent(url.pathname.slice(1));
  const sanitizedPath = path
    .normalize(relativePath)
    .replace(/^(\.\.(\/|\\|$))+/, "");
  const assetPath = path.resolve(webUiDir, sanitizedPath);
  if (!assetPath.startsWith(webUiDir)) {
    response.writeHead(404);
    response.end();
    return true;
  }

  const hasExtension = Boolean(path.extname(sanitizedPath));
  const filePath = hasExtension ? assetPath : path.join(webUiDir, "index.html");

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type":
        assetTypes.get(path.extname(filePath)) ?? "application/octet-stream",
      "cache-control": hasExtension
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return true;
  } catch {
    if (hasExtension) {
      response.writeHead(404);
      response.end();
      return true;
    }
    return false;
  }
}
