/**
 * Content script injected on the server's /join page.
 * Reads `room` and `token` query parameters and asks the background
 * service worker to join the room automatically.
 */

const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 128;

function setStatus(text: string, isError: boolean): void {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", isError);
  const spinner = document.getElementById("spinner");
  if (spinner) {
    spinner.style.display = isError ? "none" : "";
  }
}

async function init(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const room = params.get("room")?.trim().toUpperCase();
  const token = params.get("token")?.trim();

  if (!room || !ROOM_CODE_PATTERN.test(room)) {
    setStatus("房间码无效。", true);
    return;
  }
  if (
    !token ||
    token.length < TOKEN_MIN_LENGTH ||
    token.length > TOKEN_MAX_LENGTH
  ) {
    setStatus("加入码无效。", true);
    return;
  }

  setStatus(`正在加入房间 ${room}…`, false);

  try {
    const state = (await chrome.runtime.sendMessage({
      type: "join:auto-join",
      roomCode: room,
      joinToken: token,
    })) as { roomCode: string | null; error: string | null } | undefined;

    if (state?.roomCode) {
      setStatus("已成功加入房间！", false);
      history.replaceState(null, "", "/join");
    } else {
      setStatus(state?.error ?? "加入房间失败，请重试。", true);
    }
  } catch {
    setStatus("无法连接到扩展，请确认扩展已启用。", true);
  }
}

void init();
