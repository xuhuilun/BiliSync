const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 128;

export function escapeHtml(value: unknown): string {
  const normalized =
    typeof value === "string" ? value : value == null ? "" : String(value);
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function parseInviteValue(
  value: string,
): { roomCode: string; joinToken: string } | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  const separators = [":", "|", ","];
  for (const separator of separators) {
    const [roomCode, joinToken, ...rest] = normalized.split(separator);
    if (!roomCode || !joinToken || rest.length > 0) {
      continue;
    }
    const normalizedRoomCode = roomCode.toUpperCase();
    if (!ROOM_CODE_PATTERN.test(normalizedRoomCode)) {
      continue;
    }
    if (
      joinToken.length < TOKEN_MIN_LENGTH ||
      joinToken.length > TOKEN_MAX_LENGTH
    ) {
      continue;
    }
    return {
      roomCode: normalizedRoomCode,
      joinToken,
    };
  }

  return null;
}
