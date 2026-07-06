import type { ServerResponse } from "node:http";
import type { AdminErrorResponse, AdminSuccessResponse } from "./types.js";

export function sendJson<T>(
  response: ServerResponse,
  statusCode: number,
  payload: AdminSuccessResponse<T> | AdminErrorResponse,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

export function sendOk<T>(
  response: ServerResponse,
  data: T,
  statusCode = 200,
): void {
  sendJson(response, statusCode, { ok: true, data });
}

export function sendError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(response, statusCode, {
    ok: false,
    error: { code, message, details },
  });
}
