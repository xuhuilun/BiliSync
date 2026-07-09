import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { QRCodeSVG } from "qrcode.react";
import {
  Copy,
  Film,
  Link2,
  LoaderCircle,
  LogIn,
  LogOut,
  Pause,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  UserRound,
  Users,
  X,
} from "lucide-react";
import {
  isPlaybackSourceManifest,
  isServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type PlaybackSourceManifest,
  type PlaybackState,
  type RoomState,
  type ServerMessage,
  type SharedVideo,
} from "@bili-syncplay/protocol";

type ConnectionStatus = "idle" | "connecting" | "connected" | "closed";
type QrLoginStatus =
  | "idle"
  | "loading"
  | "pending"
  | "scanned"
  | "succeeded"
  | "expired"
  | "error";

type RoomSession = {
  roomCode: string;
  memberId: string;
  memberToken: string;
  joinToken: string | null;
};

type AuthProfile = {
  loggedIn: boolean;
  displayName?: string;
  avatarUrl?: string;
};

type QrLoginState = {
  status: QrLoginStatus;
  loginUrl: string | null;
  qrcodeKey: string | null;
  message: string;
};

type ResolveVideoResponse = {
  ok: boolean;
  data?: {
    video: SharedVideo;
    playbackSource: PlaybackSourceManifest;
  };
  error?: {
    code?: string;
    message?: string;
  };
};

type AuthStatusResponse = {
  ok: boolean;
  data?: {
    loggedIn: boolean;
    displayName?: string;
    avatarUrl?: string;
    qrStatus?: "pending" | "scanned" | "succeeded" | "expired";
  };
  error?: {
    message?: string;
  };
};

type QrStartResponse = {
  ok: boolean;
  data?: {
    loginUrl: string;
    qrcodeKey: string;
    expiresInSeconds: number;
  };
  error?: {
    message?: string;
  };
};

const PLAYING_SYNC_DRIFT_SECONDS = 0.65;
const PAUSED_SYNC_DRIFT_SECONDS = 0.25;
const AUTO_ALIGN_INTERVAL_MS = 1000;

function buildWsUrl(): string {
  const configuredUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (configuredUrl) {
    return configuredUrl;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function parseInviteFromLocation(): { roomCode: string; joinToken: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    roomCode: params.get("room")?.trim().toUpperCase() ?? "",
    joinToken: params.get("join")?.trim() ?? "",
  };
}

function formatRoomCredential(args: {
  roomCode: string;
  joinToken: string | null;
}): string {
  if (!args.roomCode) {
    return "";
  }
  return args.joinToken ? `${args.roomCode}:${args.joinToken}` : args.roomCode;
}

function parseRoomCredential(input: string): {
  roomCode: string;
  joinToken: string;
} {
  const trimmed = input.trim();
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) {
    return {
      roomCode: trimmed.toUpperCase(),
      joinToken: "",
    };
  }
  return {
    roomCode: trimmed.slice(0, separatorIndex).trim().toUpperCase(),
    joinToken: trimmed.slice(separatorIndex + 1).trim(),
  };
}

function expectedCurrentTime(playback: PlaybackState): number {
  if (playback.playState !== "playing") {
    return playback.currentTime;
  }
  return (
    playback.currentTime +
    ((Date.now() - playback.serverTime) / 1000) * playback.playbackRate
  );
}

function canPlayHlsNatively(video: HTMLVideoElement): boolean {
  return video.canPlayType("application/vnd.apple.mpegurl").length > 0;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "00:00";
  }
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function isDirectMediaInput(input: string): boolean {
  try {
    const url = new URL(input);
    const pathname = url.pathname.toLowerCase();
    return pathname.endsWith(".m3u8") || pathname.endsWith(".mp4");
  } catch {
    return false;
  }
}

function resolveVideoErrorMessage(
  statusCode: number,
  payload: ResolveVideoResponse,
): string {
  switch (payload.error?.code) {
    case "empty_video_link":
      return "请先粘贴视频链接";
    case "unsupported_bilibili_link":
      return "暂不支持该链接格式，请检查后重试";
    case "invalid_bilibili_video":
      return "视频不存在或当前账号无观看权限";
    case "bilibili_login_required":
      return "请先通过右上角头像扫码登录 B站账号";
    case "bilibili_resolve_failed":
      return "解析失败，请稍后重试";
    default:
      return statusCode === 401
        ? "请先通过右上角头像扫码登录 B站账号"
        : (payload.error?.message ?? "解析失败，请稍后重试");
  }
}

function attachRoomCredentialsToManifest(
  sourceManifest: PlaybackSourceManifest,
  currentSession: RoomSession,
): PlaybackSourceManifest {
  return {
    ...sourceManifest,
    variants: sourceManifest.variants.map((variant) => {
      if (!variant.url.startsWith("/api/web/media/")) {
        return variant;
      }
      const url = new URL(variant.url, window.location.origin);
      url.searchParams.set("roomCode", currentSession.roomCode);
      url.searchParams.set("memberToken", currentSession.memberToken);
      return {
        ...variant,
        url: `${url.pathname}${url.search}${url.hash}`,
      };
    }),
  };
}

function qrMessage(status: QrLoginStatus): string {
  switch (status) {
    case "loading":
      return "正在创建 B站扫码登录二维码";
    case "pending":
      return "请使用 B站 App 扫码登录";
    case "scanned":
      return "已扫码，请在手机上确认登录";
    case "succeeded":
      return "登录成功";
    case "expired":
      return "二维码已过期，请刷新后重试";
    case "error":
      return "扫码登录失败，请稍后重试";
    default:
      return "";
  }
}

export default function App() {
  const initialInvite = useMemo(parseInviteFromLocation, []);
  const [displayName, setDisplayName] = useState("Web 观众");
  const [roomCredentialInput, setRoomCredentialInput] = useState(() =>
    formatRoomCredential({
      roomCode: initialInvite.roomCode,
      joinToken: initialInvite.joinToken,
    }),
  );
  const [videoInput, setVideoInput] = useState("");
  const [isResolvingVideo, setIsResolvingVideo] = useState(false);
  const [authProfile, setAuthProfile] = useState<AuthProfile>({
    loggedIn: false,
  });
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrLogin, setQrLogin] = useState<QrLoginState>({
    status: "idle",
    loginUrl: null,
    qrcodeKey: null,
    message: "",
  });
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [manifest, setManifest] = useState<PlaybackSourceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [roomParseMessage, setRoomParseMessage] = useState<string | null>(null);
  const [nowPlayingTime, setNowPlayingTime] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const roomStateRef = useRef<RoomState | null>(null);
  const applyingRemoteRef = useRef(false);
  const autoplayAfterResolveRef = useRef(false);
  const pendingJoinTokenRef = useRef("");
  const roomParseTimerRef = useRef<number | null>(null);
  const avatarCloseTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(1);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  const showRoomParseMessage = useCallback((message: string) => {
    if (roomParseTimerRef.current !== null) {
      window.clearTimeout(roomParseTimerRef.current);
    }
    setRoomParseMessage(message);
    roomParseTimerRef.current = window.setTimeout(() => {
      setRoomParseMessage(null);
      roomParseTimerRef.current = null;
    }, 2000);
  }, []);

  useEffect(
    () => () => {
      if (roomParseTimerRef.current !== null) {
        window.clearTimeout(roomParseTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    void fetch("/api/web/auth/bilibili/login/status", {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((response) => response.json() as Promise<AuthStatusResponse>)
      .then((payload) => {
        if (payload.ok && payload.data?.loggedIn) {
          setAuthProfile({
            loggedIn: true,
            displayName: payload.data.displayName,
            avatarUrl: payload.data.avatarUrl,
          });
        }
      })
      .catch(() => undefined);
  }, []);

  const clearAvatarCloseTimer = useCallback(() => {
    if (avatarCloseTimerRef.current !== null) {
      window.clearTimeout(avatarCloseTimerRef.current);
      avatarCloseTimerRef.current = null;
    }
  }, []);

  const openAvatarMenu = useCallback(() => {
    clearAvatarCloseTimer();
    setAvatarMenuOpen(true);
  }, [clearAvatarCloseTimer]);

  const scheduleAvatarMenuClose = useCallback(() => {
    clearAvatarCloseTimer();
    avatarCloseTimerRef.current = window.setTimeout(() => {
      setAvatarMenuOpen(false);
      avatarCloseTimerRef.current = null;
    }, 300);
  }, [clearAvatarCloseTimer]);

  useEffect(() => clearAvatarCloseTimer, [clearAvatarCloseTimer]);

  const startQrLogin = useCallback(async () => {
    setAvatarMenuOpen(false);
    setQrDialogOpen(true);
    setError(null);
    setQrLogin({
      status: "loading",
      loginUrl: null,
      qrcodeKey: null,
      message: qrMessage("loading"),
    });
    try {
      const response = await fetch("/api/web/auth/bilibili/login/start", {
        method: "POST",
        credentials: "same-origin",
      });
      const payload = (await response.json()) as QrStartResponse;
      if (
        !response.ok ||
        !payload.ok ||
        !payload.data?.loginUrl ||
        !payload.data.qrcodeKey
      ) {
        throw new Error(payload.error?.message ?? "无法创建 B站扫码登录");
      }
      setQrLogin({
        status: "pending",
        loginUrl: payload.data.loginUrl,
        qrcodeKey: payload.data.qrcodeKey,
        message: qrMessage("pending"),
      });
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : qrMessage("error");
      setQrLogin({
        status: "error",
        loginUrl: null,
        qrcodeKey: null,
        message,
      });
      setError(message);
    }
  }, []);

  useEffect(() => {
    if (
      !qrDialogOpen ||
      !qrLogin.qrcodeKey ||
      (qrLogin.status !== "pending" && qrLogin.status !== "scanned")
    ) {
      return;
    }

    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/web/auth/bilibili/login/status?qrcodeKey=${encodeURIComponent(
            qrLogin.qrcodeKey ?? "",
          )}`,
          {
            cache: "no-store",
            credentials: "same-origin",
          },
        );
        const payload = (await response.json()) as AuthStatusResponse;
        if (stopped || !response.ok || !payload.ok || !payload.data) {
          return;
        }
        if (payload.data.loggedIn) {
          setAuthProfile({
            loggedIn: true,
            displayName: payload.data.displayName,
            avatarUrl: payload.data.avatarUrl,
          });
          setQrLogin((current) => ({
            ...current,
            status: "succeeded",
            message: qrMessage("succeeded"),
          }));
          setNotice("B站账号已登录");
          window.setTimeout(() => {
            if (!stopped) {
              setQrDialogOpen(false);
            }
          }, 700);
          return;
        }
        const nextStatus = payload.data.qrStatus ?? "pending";
        setQrLogin((current) => ({
          ...current,
          status: nextStatus,
          message: qrMessage(nextStatus),
        }));
      } catch {
        if (!stopped) {
          setQrLogin((current) => ({
            ...current,
            status: "error",
            message: qrMessage("error"),
          }));
        }
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, 2000);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [qrDialogOpen, qrLogin.qrcodeKey, qrLogin.status]);

  const logoutBilibili = useCallback(async () => {
    setAvatarMenuOpen(false);
    await fetch("/api/web/auth/bilibili/logout", {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => undefined);
    setAuthProfile({ loggedIn: false });
    setNotice("已退出 B站账号");
  }, []);

  const sendMessage = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接尚未建立");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }, []);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "room:created": {
        const credential = formatRoomCredential({
          roomCode: message.payload.roomCode,
          joinToken: message.payload.joinToken,
        });
        setSession({
          roomCode: message.payload.roomCode,
          memberId: message.payload.memberId,
          memberToken: message.payload.memberToken,
          joinToken: message.payload.joinToken,
        });
        setRoomCredentialInput(credential);
        setNotice("情侣房间已创建");
        return;
      }
      case "room:joined": {
        const joinToken =
          sessionRef.current?.joinToken ?? pendingJoinTokenRef.current;
        setSession({
          roomCode: message.payload.roomCode,
          memberId: message.payload.memberId,
          memberToken: message.payload.memberToken,
          joinToken,
        });
        setRoomCredentialInput(
          formatRoomCredential({
            roomCode: message.payload.roomCode,
            joinToken,
          }),
        );
        setNotice("已加入情侣房间");
        return;
      }
      case "room:state": {
        setRoomState(message.payload);
        setError(null);
        return;
      }
      case "room:member-joined":
      case "room:member-left": {
        const member = message.payload.member;
        setRoomState((current) => {
          if (!current || current.roomCode !== message.payload.roomCode) {
            return current;
          }
          if (message.type === "room:member-joined") {
            const members = current.members.some(
              (item) => item.id === member.id,
            )
              ? current.members
              : [...current.members, member];
            return { ...current, members };
          }
          return {
            ...current,
            members: current.members.filter((item) => item.id !== member.id),
          };
        });
        return;
      }
      case "error":
        setError(message.payload.message);
        return;
      case "sync:pong":
        return;
    }
  }, []);

  const connect = useCallback(
    (onOpen: (socket: WebSocket) => void) => {
      const existingSocket = socketRef.current;
      if (
        existingSocket &&
        (existingSocket.readyState === WebSocket.OPEN ||
          existingSocket.readyState === WebSocket.CONNECTING)
      ) {
        existingSocket.close();
      }

      setStatus("connecting");
      setError(null);
      const socket = new WebSocket(buildWsUrl());
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        setStatus("connected");
        onOpen(socket);
      });
      socket.addEventListener("message", (event) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (isServerMessage(parsed)) {
          handleServerMessage(parsed);
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) {
          setStatus("closed");
        }
      });
      socket.addEventListener("error", () => {
        setError("WebSocket 连接失败");
        setStatus("closed");
      });
    },
    [handleServerMessage],
  );

  const createRoom = useCallback(() => {
    connect((socket) => {
      socket.send(
        JSON.stringify({
          type: "room:create",
          payload: {
            displayName,
            protocolVersion: PROTOCOL_VERSION,
          },
        } satisfies ClientMessage),
      );
    });
  }, [connect, displayName]);

  const joinRoom = useCallback(() => {
    const { roomCode, joinToken } = parseRoomCredential(roomCredentialInput);
    setRoomCredentialInput(formatRoomCredential({ roomCode, joinToken }));
    showRoomParseMessage(
      joinToken
        ? `已解析：房间号 ${roomCode}，邀请码已识别`
        : `已解析：房间号 ${roomCode || "-"}，邀请码为空`,
    );
    if (!roomCode) {
      setError("请粘贴房间号或 房间号:邀请码");
      return;
    }
    if (!joinToken) {
      setError("请粘贴完整的 房间号:邀请码");
      return;
    }

    pendingJoinTokenRef.current = joinToken;
    connect((socket) => {
      socket.send(
        JSON.stringify({
          type: "room:join",
          payload: {
            roomCode,
            joinToken,
            displayName,
            protocolVersion: PROTOCOL_VERSION,
          },
        } satisfies ClientMessage),
      );
    });
  }, [connect, displayName, roomCredentialInput, showRoomParseMessage]);

  const copyInvite = useCallback(async () => {
    const credential = session
      ? formatRoomCredential({
          roomCode: session.roomCode,
          joinToken: session.joinToken,
        })
      : "";
    if (!credential || !session?.joinToken) {
      return;
    }
    await navigator.clipboard.writeText(credential);
    setNotice("房间号和邀请码已复制");
  }, [session]);

  const loadPlaybackSource = useCallback(async (nextSession: RoomSession) => {
    const response = await fetch(
      `/api/web/rooms/${nextSession.roomCode}/playback-source?memberToken=${encodeURIComponent(
        nextSession.memberToken,
      )}`,
      {
        cache: "no-store",
        credentials: "same-origin",
      },
    );
    const payload = (await response.json()) as {
      ok: boolean;
      data?: { playbackSource?: unknown };
      error?: { message?: string };
    };
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error?.message ?? "无法加载播放源");
    }
    if (!isPlaybackSourceManifest(payload.data?.playbackSource)) {
      throw new Error("播放源清单格式无效");
    }
    setManifest(
      attachRoomCredentialsToManifest(payload.data.playbackSource, nextSession),
    );
  }, []);

  useEffect(() => {
    const currentSession = session;
    const sharedVideo = roomState?.sharedVideo;
    if (
      !currentSession ||
      !sharedVideo ||
      (sharedVideo.sourceProvider !== "direct" &&
        sharedVideo.sourceProvider !== "authorized-bilibili")
    ) {
      setManifest(null);
      return;
    }
    void loadPlaybackSource(currentSession).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "无法加载播放源");
    });
  }, [loadPlaybackSource, roomState?.sharedVideo, session]);

  const shareVideo = useCallback(async () => {
    const currentSession = sessionRef.current;
    const videoElement = videoRef.current;
    const input = videoInput.trim();
    if (!currentSession) {
      setError("请先创建或加入房间");
      return;
    }
    if (!input) {
      setError("请先粘贴视频链接");
      return;
    }

    setIsResolvingVideo(true);
    setError(null);
    setNotice(null);
    try {
      const body = isDirectMediaInput(input) ? { url: input } : { input };
      const response = await fetch("/api/web/video/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as ResolveVideoResponse;
      if (!response.ok || !payload.ok || !payload.data) {
        setError(resolveVideoErrorMessage(response.status, payload));
        return;
      }

      autoplayAfterResolveRef.current = true;
      setManifest(
        attachRoomCredentialsToManifest(
          payload.data.playbackSource,
          currentSession,
        ),
      );
      sendMessage({
        type: "video:share",
        payload: {
          memberToken: currentSession.memberToken,
          video: payload.data.video,
          playback: {
            url: payload.data.video.url,
            currentTime: videoElement?.currentTime ?? 0,
            playState: "playing",
            playbackRate: videoElement?.playbackRate ?? 1,
            updatedAt: Date.now(),
            serverTime: 0,
            actorId: currentSession.memberId,
            seq: sequenceRef.current++,
            userInitiated: true,
          },
        },
      });
      setNotice("解析成功，正在加载播放器");
    } catch {
      setError("解析失败，请稍后重试");
    } finally {
      setIsResolvingVideo(false);
    }
  }, [sendMessage, videoInput]);

  const activeVariant = manifest?.variants[0] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeVariant) {
      return;
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.removeAttribute("src");
    video.load();

    const playAfterResolve = () => {
      if (!autoplayAfterResolveRef.current) {
        return;
      }
      autoplayAfterResolveRef.current = false;
      void video
        .play()
        .then(() => {
          setNotice("视频已解析并开始播放");
        })
        .catch(() => {
          setError("浏览器阻止了自动播放，请点击一次播放器");
        });
    };

    if (activeVariant.kind === "hls" && !canPlayHlsNatively(video)) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          maxBufferLength: 20,
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.MANIFEST_PARSED, playAfterResolve);
        hls.loadSource(activeVariant.url);
        hls.attachMedia(video);
      } else {
        setError("当前浏览器不支持 HLS 播放");
      }
    } else {
      video.src = activeVariant.url;
      video.addEventListener("loadedmetadata", playAfterResolve, {
        once: true,
      });
      video.load();
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeEventListener("loadedmetadata", playAfterResolve);
    };
  }, [activeVariant]);

  const sendPlaybackUpdate = useCallback(
    (syncIntent?: PlaybackState["syncIntent"]) => {
      const video = videoRef.current;
      const currentSession = sessionRef.current;
      const sharedVideo = roomStateRef.current?.sharedVideo;
      if (
        !video ||
        !currentSession ||
        !sharedVideo ||
        applyingRemoteRef.current
      ) {
        return;
      }

      const now = Date.now();
      const playState: PlaybackState["playState"] = video.paused
        ? "paused"
        : "playing";

      sendMessage({
        type: "playback:update",
        payload: {
          memberToken: currentSession.memberToken,
          playback: {
            url: sharedVideo.url,
            currentTime: video.currentTime,
            playState,
            syncIntent,
            playbackRate: video.playbackRate,
            updatedAt: now,
            serverTime: 0,
            actorId: currentSession.memberId,
            seq: sequenceRef.current++,
            userInitiated: true,
          },
        },
      });
    },
    [sendMessage],
  );

  const applyPlaybackState = useCallback(
    async (playback: PlaybackState, force = false) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      applyingRemoteRef.current = true;
      video.playbackRate = playback.playbackRate;

      const targetTime = expectedCurrentTime(playback);
      const driftLimit =
        playback.playState === "playing"
          ? PLAYING_SYNC_DRIFT_SECONDS
          : PAUSED_SYNC_DRIFT_SECONDS;
      if (
        Number.isFinite(targetTime) &&
        (force || Math.abs(video.currentTime - targetTime) > driftLimit)
      ) {
        video.currentTime = Math.max(0, targetTime);
      }

      if (playback.playState === "playing") {
        try {
          await video.play();
        } catch {
          setError("浏览器阻止了自动播放，请点击一次播放器");
        }
      } else {
        video.pause();
      }
      window.setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 180);
    },
    [],
  );

  useEffect(() => {
    const playback = roomState?.playback;
    if (!playback || playback.actorId === session?.memberId) {
      return;
    }
    void applyPlaybackState(playback, true);
  }, [applyPlaybackState, roomState?.playback, session?.memberId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const playback = roomStateRef.current?.playback;
      if (
        playback &&
        playback.actorId !== sessionRef.current?.memberId &&
        videoRef.current
      ) {
        void applyPlaybackState(playback);
      }
      setNowPlayingTime(videoRef.current?.currentTime ?? 0);
    }, AUTO_ALIGN_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [applyPlaybackState]);

  const realignLocal = useCallback(() => {
    const playback = roomStateRef.current?.playback;
    if (playback) {
      void applyPlaybackState(playback, true);
      setNotice("已按房间状态重新对齐");
    }
  }, [applyPlaybackState]);

  const connectionLabel =
    status === "connected"
      ? "已连接"
      : status === "connecting"
        ? "连接中"
        : status === "closed"
          ? "已断开"
          : "未连接";

  return (
    <main className="app-shell">
      <aside className="side-panel" aria-label="房间控制">
        <div className="brand-row">
          <div className="brand-copy">
            <div className="brand-mark">B</div>
            <div>
              <p className="eyebrow">BILISYNC COUPLE ROOM</p>
              <h1>B站一起看</h1>
            </div>
          </div>

          <div
            className="avatar-menu"
            onMouseEnter={openAvatarMenu}
            onMouseLeave={scheduleAvatarMenuClose}
          >
            <button
              type="button"
              className={`avatar-button ${authProfile.loggedIn ? "is-logged-in" : ""}`}
              aria-label="B站账号菜单"
              onClick={() => setAvatarMenuOpen((current) => !current)}
            >
              {authProfile.loggedIn && authProfile.avatarUrl ? (
                <img src={authProfile.avatarUrl} alt="" />
              ) : (
                <UserRound size={24} />
              )}
            </button>
            {avatarMenuOpen ? (
              <div className="avatar-popover" role="menu">
                {authProfile.loggedIn ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={startQrLogin}
                    >
                      <RefreshCw size={16} />
                      切换账号
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={logoutBilibili}
                    >
                      <LogOut size={16} />
                      退出登录
                    </button>
                  </>
                ) : (
                  <button type="button" role="menuitem" onClick={startQrLogin}>
                    <QrCode size={16} />
                    登录
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className={`status-pill status-${status}`}>
          <span />
          {connectionLabel}
        </div>

        <section className="panel-section">
          <div className="section-heading">
            <Users size={18} />
            <span>情侣房间</span>
          </div>
          <label>
            昵称
            <input
              value={displayName}
              maxLength={32}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button type="button" className="primary" onClick={createRoom}>
              <Radio size={18} />
              创建房间
            </button>
            <button type="button" onClick={joinRoom}>
              <LogIn size={18} />
              加入房间
            </button>
          </div>
          <label>
            房间凭证
            <input
              value={roomCredentialInput}
              placeholder="请粘贴 ‘房间号:邀请码’ 格式"
              onChange={(event) => setRoomCredentialInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  joinRoom();
                }
              }}
            />
          </label>
          {roomParseMessage ? (
            <p className="parse-result-toast" role="status">
              {roomParseMessage}
            </p>
          ) : null}
          {session ? (
            <div className="room-card">
              <div>
                <span>当前房间</span>
                <strong>{session.roomCode}</strong>
              </div>
              {session.joinToken ? (
                <button
                  type="button"
                  className="icon-button"
                  title="复制房间号:邀请码"
                  onClick={copyInvite}
                >
                  <Copy size={18} />
                </button>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="panel-section">
          <div className="section-heading">
            <Film size={18} />
            <span>B站视频链接解析与播放</span>
          </div>
          <form
            className="resolve-form"
            onSubmit={(event) => {
              event.preventDefault();
              void shareVideo();
            }}
          >
            <label>
              视频链接
              <div className="resolve-row">
                <input
                  value={videoInput}
                  disabled={isResolvingVideo}
                  placeholder="请粘贴B站视频链接"
                  onChange={(event) => setVideoInput(event.target.value)}
                />
                <button
                  type="submit"
                  className="primary"
                  disabled={isResolvingVideo}
                >
                  {isResolvingVideo ? (
                    <LoaderCircle className="spin-icon" size={18} />
                  ) : (
                    <Link2 size={18} />
                  )}
                  {isResolvingVideo ? "解析中" : "解析"}
                </button>
              </div>
            </label>
          </form>
        </section>

        <section className="members-strip">
          <div className="section-heading">
            <Users size={18} />
            <span>{roomState?.members.length ?? 0}/2 在线</span>
          </div>
          <div className="member-list">
            {(roomState?.members ?? []).map((member) => (
              <span key={member.id}>{member.name}</span>
            ))}
          </div>
        </section>
      </aside>

      <section className="watch-stage" aria-label="同步播放器">
        <div className="top-bar">
          <div>
            <p className="eyebrow">AUTO ALIGNED PLAYBACK</p>
            <h2>{roomState?.sharedVideo?.title ?? "等待分享视频"}</h2>
          </div>
          <button type="button" onClick={realignLocal}>
            <RefreshCw size={18} />
            重新对齐
          </button>
        </div>

        <div className="video-frame">
          {activeVariant ? null : (
            <div className="empty-player">
              <LoaderCircle size={24} />
              <span>等待播放源</span>
            </div>
          )}
          <video
            ref={videoRef}
            controls
            playsInline
            poster={manifest?.posterUrl}
            onPlay={() => sendPlaybackUpdate()}
            onPause={() => sendPlaybackUpdate()}
            onSeeked={() => sendPlaybackUpdate("explicit-seek")}
            onTimeUpdate={() => {
              setNowPlayingTime(videoRef.current?.currentTime ?? 0);
            }}
            onError={() => {
              setError("视频加载失败，请确认账号有观看权限后重新解析");
            }}
          />
        </div>

        <div className="now-bar">
          <div>
            <p>{activeVariant ? activeVariant.label : "无播放源"}</p>
            <span>自动本地对齐开启，不会定时向服务器上报进度</span>
          </div>
          <div className="transport-state">
            {roomState?.playback?.playState === "playing" ? (
              <Play size={18} />
            ) : (
              <Pause size={18} />
            )}
            <span>{formatTime(nowPlayingTime)}</span>
          </div>
        </div>

        {notice ? <p className="notice-line">{notice}</p> : null}
        {error ? <p className="error-line">{error}</p> : null}

        <div className="rules-row">
          <span>
            <Link2 size={15} />
            播放 / 暂停 / 拖拽触发同步
          </span>
          <span>
            <RefreshCw size={15} />
            本地每秒自动检测偏差
          </span>
        </div>
      </section>

      {qrDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <div className="qr-dialog" role="dialog" aria-modal="true">
            <div className="qr-dialog-head">
              <div>
                <p className="eyebrow">BILIBILI QR LOGIN</p>
                <h3>B站扫码登录</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭"
                onClick={() => setQrDialogOpen(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className={`qr-box qr-${qrLogin.status}`}>
              {qrLogin.loginUrl ? (
                <QRCodeSVG
                  value={qrLogin.loginUrl}
                  size={220}
                  marginSize={2}
                  level="M"
                />
              ) : (
                <LoaderCircle size={36} />
              )}
            </div>
            <p className="qr-message">{qrLogin.message}</p>
            <div className="qr-actions">
              <button type="button" onClick={startQrLogin}>
                <RefreshCw size={18} />
                刷新二维码
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
