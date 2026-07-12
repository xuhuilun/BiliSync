export async function createTrtcUserId(memberId: string): Promise<string> {
  const bytes = new TextEncoder().encode(memberId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `web_${hex.slice(0, 28)}`;
}
