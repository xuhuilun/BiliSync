import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { QRCodeSVG } from "qrcode.react";
import {
  Copy,
  Film,
  Link2,
  LoaderCircle,
  LogOut,
  Mic,
  MicOff,
  Pause,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Users,
  X,
} from "lucide-react";
import { createTrtcVoiceAdapter } from "./voice/trtc-adapter.js";
import { createTrtcUserId } from "./voice/member-identity.js";
import { VoiceDuckingController } from "./voice/voice-ducking.js";
import {
  VoiceSessionController,
  type VoiceCredential,
  type VoiceSessionState,
} from "./voice/voice-session.js";
import {
  decidePlaybackFallback,
  getRelevantBufferedEnd,
  isServerProxyVariant,
  MediaFallbackTimer,
} from "./playback-source-fallback.js";
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

type VoiceTokenResponse = {
  ok: boolean;
  data?: VoiceCredential;
  error?: { message?: string };
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
const REMOTE_APPLY_SUPPRESSION_MS = 1000;

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

function buildInviteUrl(args: {
  roomCode: string;
  joinToken: string | null;
}): string {
  if (!args.roomCode || !args.joinToken) {
    return "";
  }
  const base = `${window.location.origin}/join`;
  return `${base}?room=${encodeURIComponent(args.roomCode)}&join=${encodeURIComponent(args.joinToken)}`;
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
  const [videoInput, setVideoInput] = useState("");
  const [isResolvingVideo, setIsResolvingVideo] = useState(false);
  const [authProfile, setAuthProfile] = useState<AuthProfile>({
    loggedIn: false,
  });
  const [authChecked, setAuthChecked] = useState(false);
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const [avatarErrored, setAvatarErrored] = useState(false);
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
  const [activeVariantIndex, setActiveVariantIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [nowPlayingTime, setNowPlayingTime] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceSessionState>({
    status: "idle",
    muted: false,
    error: null,
  });
  const [voiceVolumes, setVoiceVolumes] = useState<Record<string, number>>({});
  const [memberVoiceIds, setMemberVoiceIds] = useState<Record<string, string>>(
    {},
  );
  const [memberVolumes, setMemberVolumes] = useState<Record<string, number>>(
    {},
  );
  const [pushToTalkEnabled, setPushToTalkEnabled] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const roomStateRef = useRef<RoomState | null>(null);
  const applyingRemoteRef = useRef(false);
  const suppressLocalPlaybackEventsUntilRef = useRef(0);
  const autoplayAfterResolveRef = useRef(false);
  const pendingJoinTokenRef = useRef("");
  const avatarCloseTimerRef = useRef<number | null>(null);
  const sequenceRef = useRef(1);
  const voiceControllerRef = useRef<VoiceSessionController | null>(null);
  const duckingControllerRef = useRef<VoiceDuckingController | null>(null);
  const videoVolumeBeforeDuckingRef = useRef(1);
  const fallbackTimerRef = useRef<MediaFallbackTimer | null>(null);
  const fallbackInFlightRef = useRef(false);
  const playbackResumeRef = useRef<{
    currentTime: number;
    playbackRate: number;
    shouldPlay: boolean;
  } | null>(null);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  useEffect(() => {
    setAvatarErrored(false);
  }, [authProfile.avatarUrl]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      (roomState?.members ?? []).map(
        async (member) =>
          [member.id, await createTrtcUserId(member.id)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) {
        setMemberVoiceIds(Object.fromEntries(entries));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [roomState?.members]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const controller = new VoiceDuckingController({
      onGainChange: (gain) => {
        if (gain < 1) {
          videoVolumeBeforeDuckingRef.current = video.volume;
        }
        video.volume = Math.max(
          0,
          Math.min(1, videoVolumeBeforeDuckingRef.current * gain),
        );
      },
    });
    duckingControllerRef.current = controller;
    return () => {
      controller.dispose();
      duckingControllerRef.current = null;
    };
  }, []);

  const sharedVideoSourceKey = useMemo(() => {
    const sharedVideo = roomState?.sharedVideo;
    if (!sharedVideo) {
      return null;
    }
    return [
      sharedVideo.sourceProvider,
      sharedVideo.sourceRef,
      sharedVideo.videoId,
      sharedVideo.url,
    ].join("|");
  }, [
    roomState?.sharedVideo?.sourceProvider,
    roomState?.sharedVideo?.sourceRef,
    roomState?.sharedVideo?.videoId,
    roomState?.sharedVideo?.url,
  ]);

  const sessionKey = useMemo(() => {
    if (!session) {
      return null;
    }
    return `${session.roomCode}:${session.memberToken}`;
  }, [session?.memberToken, session?.roomCode]);

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
      .catch(() => undefined)
      .finally(() => setAuthChecked(true));
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
          setQrDialogOpen(false);
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

  const leaveVoice = useCallback(async () => {
    const controller = voiceControllerRef.current;
    voiceControllerRef.current = null;
    if (controller) {
      await controller.leave().catch(() => undefined);
    }
    duckingControllerRef.current?.dispose();
    setVoiceVolumes({});
    setVoiceState({ status: "idle", muted: false, error: null });
  }, []);

  const joinVoice = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (
      !currentSession ||
      (voiceState.status !== "idle" && voiceState.status !== "error")
    ) {
      return;
    }
    setError(null);
    try {
      const response = await fetch("/api/web/voice/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          roomCode: currentSession.roomCode,
          memberToken: currentSession.memberToken,
        }),
      });
      const payload = (await response.json()) as VoiceTokenResponse;
      if (!response.ok || !payload.ok || !payload.data) {
        throw new Error(payload.error?.message ?? "无法加入语音");
      }

      const controller = new VoiceSessionController(
        await createTrtcVoiceAdapter(),
        {
          onStateChange: setVoiceState,
          onRemoteVolume: (userId, volume) => {
            setVoiceVolumes((current) => ({ ...current, [userId]: volume }));
            duckingControllerRef.current?.setSpeaking(userId, volume >= 15);
          },
        },
      );
      voiceControllerRef.current = controller;
      await controller.join(payload.data);
      setNotice("已加入房间语音");
    } catch (reason) {
      voiceControllerRef.current = null;
      const message = reason instanceof Error ? reason.message : "无法加入语音";
      setVoiceState({ status: "error", muted: true, error: message });
      setError(message);
    }
  }, [voiceState.status]);

  const toggleVoiceMuted = useCallback(async () => {
    const controller = voiceControllerRef.current;
    if (!controller) {
      return;
    }
    try {
      await controller.setMuted(!voiceState.muted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "麦克风操作失败");
    }
  }, [voiceState.muted]);

  useEffect(() => {
    if (!pushToTalkEnabled || voiceState.status !== "joined") {
      return;
    }
    void voiceControllerRef.current?.setMuted(true);
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element?.isContentEditable ||
        element?.closest("input, textarea, select, [contenteditable='true']"),
      );
    };
    const keyDown = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      void voiceControllerRef.current?.setMuted(false);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      void voiceControllerRef.current?.setMuted(true);
    };
    const forceMute = () => {
      void voiceControllerRef.current?.setMuted(true);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", forceMute);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", forceMute);
    };
  }, [pushToTalkEnabled, voiceState.status]);

  useEffect(
    () => () => {
      void voiceControllerRef.current?.leave();
      voiceControllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!session) {
      void leaveVoice();
    }
  }, [leaveVoice, session]);

  const handleServerMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "room:created": {
        setSession({
          roomCode: message.payload.roomCode,
          memberId: message.payload.memberId,
          memberToken: message.payload.memberToken,
          joinToken: message.payload.joinToken,
        });
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

  const displayName = authProfile.displayName ?? "Web 观众";

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

  const autoJoinRoom = useCallback(
    (roomCode: string, joinToken: string) => {
      if (!roomCode || !joinToken) {
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
    },
    [connect, displayName],
  );

  useEffect(() => {
    if (authChecked && initialInvite.roomCode && initialInvite.joinToken) {
      autoJoinRoom(initialInvite.roomCode, initialInvite.joinToken);
    }
  }, [
    autoJoinRoom,
    authChecked,
    initialInvite.joinToken,
    initialInvite.roomCode,
  ]);

  const copyInvite = useCallback(async () => {
    const inviteUrl = session
      ? buildInviteUrl({
          roomCode: session.roomCode,
          joinToken: session.joinToken,
        })
      : "";
    if (!inviteUrl) {
      return;
    }
    await navigator.clipboard.writeText(inviteUrl);
    setNotice("邀请链接已复制");
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
    const nextManifest = attachRoomCredentialsToManifest(
      payload.data.playbackSource,
      nextSession,
    );
    setActiveVariantIndex(0);
    setManifest(nextManifest);
    return nextManifest;
  }, []);

  useEffect(() => {
    const currentSession = sessionRef.current;
    const sharedVideo = roomStateRef.current?.sharedVideo;
    if (
      !currentSession ||
      !sharedVideo ||
      (sharedVideo.sourceProvider !== "direct" &&
        sharedVideo.sourceProvider !== "authorized-bilibili")
    ) {
      setManifest(null);
      setActiveVariantIndex(0);
      return;
    }
    void loadPlaybackSource(currentSession).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "无法加载播放源");
    });
  }, [loadPlaybackSource, sessionKey, sharedVideoSourceKey]);

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
      const body = isDirectMediaInput(input)
        ? { url: input }
        : {
            input,
            roomCode: currentSession.roomCode,
            memberToken: currentSession.memberToken,
          };
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
      setActiveVariantIndex(0);
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
            currentTime: 0,
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

  const rememberPlaybackForSourceSwitch = useCallback(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    playbackResumeRef.current = {
      currentTime: video.currentTime,
      playbackRate: video.playbackRate,
      shouldPlay: !video.paused,
    };
    suppressLocalPlaybackEventsUntilRef.current = Date.now() + 1_500;
  }, []);

  const fallbackPlaybackSource = useCallback(
    async (reason: "media-error" | "metadata-timeout" | "stalled") => {
      if (fallbackInFlightRef.current || !manifest) {
        return;
      }
      fallbackInFlightRef.current = true;
      fallbackTimerRef.current?.dispose();
      rememberPlaybackForSourceSwitch();
      try {
        const decision = decidePlaybackFallback({
          manifest,
          activeVariantIndex,
          now: Date.now(),
        });
        if (decision.kind === "refresh") {
          const currentSession = sessionRef.current;
          if (!currentSession) {
            throw new Error("当前房间会话已失效");
          }
          await loadPlaybackSource(currentSession);
          setNotice("播放地址已刷新");
          return;
        }
        if (decision.kind === "next") {
          setActiveVariantIndex(decision.variantIndex);
          setNotice(
            decision.variantIndex === manifest.variants.length - 1
              ? "CDN 直连不可用，已切换服务器代理"
              : "正在尝试备用 CDN",
          );
          return;
        }
        playbackResumeRef.current = null;
        const reasonLabel =
          reason === "media-error"
            ? "视频加载错误"
            : reason === "metadata-timeout"
              ? "视频加载超时"
              : "视频持续卡顿";
        setError(`${reasonLabel}，所有播放线路均不可用，请重新获取播放地址`);
      } catch (reason) {
        playbackResumeRef.current = null;
        setError(reason instanceof Error ? reason.message : "无法刷新播放地址");
      } finally {
        fallbackInFlightRef.current = false;
      }
    },
    [
      activeVariantIndex,
      loadPlaybackSource,
      manifest,
      rememberPlaybackForSourceSwitch,
    ],
  );

  const retryPlaybackSource = useCallback(async () => {
    const currentSession = sessionRef.current;
    if (!currentSession) {
      setError("请先创建或加入房间");
      return;
    }
    rememberPlaybackForSourceSwitch();
    setError(null);
    try {
      await loadPlaybackSource(currentSession);
      setNotice("已重新获取播放地址");
    } catch (reason) {
      playbackResumeRef.current = null;
      setError(reason instanceof Error ? reason.message : "无法刷新播放地址");
    }
  }, [loadPlaybackSource, rememberPlaybackForSourceSwitch]);

  const activeVariant = manifest?.variants[activeVariantIndex] ?? null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeVariant) {
      return;
    }

    hlsRef.current?.destroy();
    hlsRef.current = null;
    video.setAttribute("referrerpolicy", "no-referrer");
    video.removeAttribute("src");
    video.load();

    const timer = new MediaFallbackTimer({
      mode: isServerProxyVariant(activeVariant.url, window.location.origin)
        ? "proxy"
        : "direct",
      onFallback: (reason) => {
        void fallbackPlaybackSource(reason);
      },
    });
    fallbackTimerRef.current = timer;
    timer.armMetadataTimeout();

    const restorePlayback = () => {
      timer.markMetadataLoaded();
      const resume = playbackResumeRef.current;
      if (!resume) {
        return;
      }
      playbackResumeRef.current = null;
      video.playbackRate = resume.playbackRate;
      if (Number.isFinite(resume.currentTime) && resume.currentTime > 0) {
        video.currentTime = resume.currentTime;
      }
      if (resume.shouldPlay) {
        void video.play().catch(() => {
          setError("浏览器阻止了自动恢复播放，请点击播放器继续");
        });
      }
    };
    video.addEventListener("loadedmetadata", restorePlayback);

    const markInitialized = () => timer.markMetadataLoaded();
    const markPlayable = () => timer.markPlayable();
    const markProgress = () => {
      timer.markProgress(
        getRelevantBufferedEnd(video.buffered, video.currentTime),
      );
    };
    video.addEventListener("loadeddata", markInitialized);
    video.addEventListener("canplay", markInitialized);
    video.addEventListener("playing", markPlayable);
    video.addEventListener("canplay", markPlayable);
    video.addEventListener("progress", markProgress);

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
      timer.dispose();
      if (fallbackTimerRef.current === timer) {
        fallbackTimerRef.current = null;
      }
      video.removeEventListener("loadedmetadata", restorePlayback);
      video.removeEventListener("loadedmetadata", playAfterResolve);
      video.removeEventListener("loadeddata", markInitialized);
      video.removeEventListener("canplay", markInitialized);
      video.removeEventListener("playing", markPlayable);
      video.removeEventListener("canplay", markPlayable);
      video.removeEventListener("progress", markProgress);
    };
  }, [activeVariant, fallbackPlaybackSource]);

  const sendPlaybackUpdate = useCallback(
    (syncIntent?: PlaybackState["syncIntent"]) => {
      const video = videoRef.current;
      const currentSession = sessionRef.current;
      const sharedVideo = roomStateRef.current?.sharedVideo;
      if (
        !video ||
        !currentSession ||
        !sharedVideo ||
        applyingRemoteRef.current ||
        Date.now() < suppressLocalPlaybackEventsUntilRef.current
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
      const targetTime = expectedCurrentTime(playback);
      const driftLimit =
        playback.playState === "playing"
          ? PLAYING_SYNC_DRIFT_SECONDS
          : PAUSED_SYNC_DRIFT_SECONDS;
      const canSeek = video.readyState > HTMLMediaElement.HAVE_NOTHING;
      if (!canSeek && Number.isFinite(targetTime) && targetTime > 0.25) {
        return;
      }

      const shouldSeek =
        canSeek &&
        Number.isFinite(targetTime) &&
        (force || Math.abs(video.currentTime - targetTime) > driftLimit);
      const shouldUpdateRate =
        Math.abs(video.playbackRate - playback.playbackRate) > 0.001;
      const shouldPlay = playback.playState === "playing" && video.paused;
      const shouldPause = playback.playState !== "playing" && !video.paused;

      if (!shouldSeek && !shouldUpdateRate && !shouldPlay && !shouldPause) {
        return;
      }

      applyingRemoteRef.current = true;
      suppressLocalPlaybackEventsUntilRef.current = Math.max(
        suppressLocalPlaybackEventsUntilRef.current,
        Date.now() + REMOTE_APPLY_SUPPRESSION_MS,
      );

      if (shouldUpdateRate) {
        video.playbackRate = playback.playbackRate;
      }
      if (shouldSeek) {
        video.currentTime = Math.max(0, targetTime);
      }

      if (shouldPlay) {
        try {
          await video.play();
        } catch {
          setError("浏览器阻止了自动播放，请点击一次播放器");
        }
      } else if (shouldPause) {
        video.pause();
      }
      window.setTimeout(() => {
        if (Date.now() >= suppressLocalPlaybackEventsUntilRef.current) {
          applyingRemoteRef.current = false;
        }
      }, REMOTE_APPLY_SUPPRESSION_MS);
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
              {authProfile.loggedIn ? (
                <img
                  src={
                    authProfile.avatarUrl && !avatarErrored
                      ? authProfile.avatarUrl
                      : "/default-avatar.png"
                  }
                  alt="用户头像"
                  onError={() => setAvatarErrored(true)}
                />
              ) : null}
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
          <div className="button-row">
            <button type="button" className="primary" onClick={createRoom}>
              <Radio size={18} />
              创建房间
            </button>
          </div>
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
                  title="复制邀请链接"
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

        <section className="panel-section voice-panel">
          <div className="section-heading voice-heading">
            <Mic size={18} />
            <span>房间语音</span>
            <span className={`voice-status voice-${voiceState.status}`}>
              {voiceState.status === "joined"
                ? voiceState.muted
                  ? "已静音"
                  : "通话中"
                : voiceState.status === "joining"
                  ? "连接中"
                  : voiceState.status === "error"
                    ? "不可用"
                    : "未加入"}
            </span>
          </div>
          <div className="voice-actions">
            {voiceState.status === "idle" || voiceState.status === "error" ? (
              <button
                type="button"
                className="primary"
                disabled={!session}
                onClick={() => {
                  void joinVoice();
                }}
              >
                <Mic size={18} />
                加入语音
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={voiceState.status !== "joined"}
                  onClick={() => void toggleVoiceMuted()}
                >
                  {voiceState.muted ? <MicOff size={18} /> : <Mic size={18} />}
                  {voiceState.muted ? "解除静音" : "麦克风静音"}
                </button>
                <button
                  type="button"
                  className={pushToTalkEnabled ? "is-active" : ""}
                  disabled={voiceState.status !== "joined"}
                  onClick={() => setPushToTalkEnabled((enabled) => !enabled)}
                  title="启用后按住空格说话"
                >
                  按键说话 {pushToTalkEnabled ? "开" : "关"}
                </button>
                <button type="button" onClick={() => void leaveVoice()}>
                  退出语音
                </button>
              </>
            )}
          </div>
          {voiceState.error ? (
            <p className="voice-error">{voiceState.error}</p>
          ) : null}
        </section>

        <section className="members-strip">
          <div className="section-heading">
            <Users size={18} />
            <span>{roomState?.members.length ?? 0}/2 在线</span>
          </div>
          <div className="member-list voice-member-list">
            {(roomState?.members ?? []).map((member) => {
              const voiceUserId = memberVoiceIds[member.id];
              const volume = voiceUserId ? (voiceVolumes[voiceUserId] ?? 0) : 0;
              const speaking = volume >= 15;
              const remoteVolume = memberVolumes[member.id] ?? 100;
              const isSelf = member.id === session?.memberId;
              return (
                <div
                  key={member.id}
                  className={`voice-member ${speaking ? "is-speaking" : ""}`}
                >
                  <span className="voice-avatar" aria-hidden="true">
                    {member.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="voice-member-name">
                    {member.name}
                    {isSelf ? "（我）" : ""}
                  </span>
                  {!isSelf && voiceState.status === "joined" ? (
                    <label className="voice-volume">
                      <span>音量 {remoteVolume}%</span>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={remoteVolume}
                        onChange={(event) => {
                          const nextVolume = Number(event.target.value);
                          setMemberVolumes((current) => ({
                            ...current,
                            [member.id]: nextVolume,
                          }));
                          if (voiceUserId) {
                            voiceControllerRef.current?.setRemoteVolume(
                              voiceUserId,
                              nextVolume,
                            );
                          }
                        }}
                      />
                    </label>
                  ) : null}
                </div>
              );
            })}
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
            onPlay={() => {
              fallbackTimerRef.current?.markPlayable();
              sendPlaybackUpdate();
            }}
            onCanPlay={() => fallbackTimerRef.current?.markPlayable()}
            onWaiting={() => fallbackTimerRef.current?.armStallTimeout()}
            onStalled={() => fallbackTimerRef.current?.armStallTimeout()}
            onPause={() => sendPlaybackUpdate()}
            onSeeked={() => sendPlaybackUpdate("explicit-seek")}
            onTimeUpdate={() => {
              setNowPlayingTime(videoRef.current?.currentTime ?? 0);
            }}
            onError={() => {
              void fallbackPlaybackSource("media-error");
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
        {error ? (
          <div className="error-line playback-error-line">
            <span>{error}</span>
            {session && roomState?.sharedVideo ? (
              <button type="button" onClick={() => void retryPlaybackSource()}>
                重新获取播放地址
              </button>
            ) : null}
          </div>
        ) : null}

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
