import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import {
  Copy,
  Link2,
  LoaderCircle,
  LogIn,
  Pause,
  Play,
  Radio,
  Share2,
  Users,
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

type RoomSession = {
  roomCode: string;
  memberId: string;
  memberToken: string;
  joinToken: string | null;
};

type ResolveVideoResponse = {
  ok: boolean;
  data?: {
    video: SharedVideo;
    playbackSource: PlaybackSourceManifest;
  };
  error?: {
    message?: string;
  };
};

const SYNC_DRIFT_SECONDS = 0.65;
const PLAYBACK_SEND_INTERVAL_MS = 900;

function buildWsUrl(): string {
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

function toInviteUrl(session: RoomSession | null): string {
  if (!session?.joinToken) {
    return "";
  }
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("room", session.roomCode);
  url.searchParams.set("join", session.joinToken);
  return url.toString();
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

export default function App() {
  const initialInvite = useMemo(parseInviteFromLocation, []);
  const [displayName, setDisplayName] = useState("Web 观众");
  const [roomCodeInput, setRoomCodeInput] = useState(initialInvite.roomCode);
  const [joinTokenInput, setJoinTokenInput] = useState(initialInvite.joinToken);
  const [directUrl, setDirectUrl] = useState("");
  const [directTitle, setDirectTitle] = useState("");
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [session, setSession] = useState<RoomSession | null>(null);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [manifest, setManifest] = useState<PlaybackSourceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nowPlayingTime, setNowPlayingTime] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  const roomStateRef = useRef<RoomState | null>(null);
  const applyingRemoteRef = useRef(false);
  const sequenceRef = useRef(1);
  const lastSentAtRef = useRef(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    roomStateRef.current = roomState;
  }, [roomState]);

  const sendMessage = useCallback((message: ClientMessage): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("连接尚未建立");
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
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
        if (!isServerMessage(parsed)) {
          return;
        }
        handleServerMessage(parsed);
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
    [],
  );

  const handleServerMessage = useCallback((message: ServerMessage) => {
    switch (message.type) {
      case "room:created": {
        setSession({
          roomCode: message.payload.roomCode,
          memberId: message.payload.memberId,
          memberToken: message.payload.memberToken,
          joinToken: message.payload.joinToken,
        });
        return;
      }
      case "room:joined": {
        setSession((current) => ({
          roomCode: message.payload.roomCode,
          memberId: message.payload.memberId,
          memberToken: message.payload.memberToken,
          joinToken: current?.joinToken ?? joinTokenInput,
        }));
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
            const members = current.members.some((item) => item.id === member.id)
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
  }, [joinTokenInput]);

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
    const roomCode = roomCodeInput.trim().toUpperCase();
    const joinToken = joinTokenInput.trim();
    if (!roomCode || !joinToken) {
      setError("请输入房间号和邀请码");
      return;
    }

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
  }, [connect, displayName, joinTokenInput, roomCodeInput]);

  const inviteUrl = useMemo(() => toInviteUrl(session), [session]);

  const copyInvite = useCallback(async () => {
    if (!inviteUrl) {
      return;
    }
    await navigator.clipboard.writeText(inviteUrl);
  }, [inviteUrl]);

  const loadPlaybackSource = useCallback(async (nextSession: RoomSession) => {
    const response = await fetch(
      `/api/web/rooms/${nextSession.roomCode}/playback-source?memberToken=${encodeURIComponent(
        nextSession.memberToken,
      )}`,
      { cache: "no-store" },
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
    setManifest(payload.data.playbackSource);
  }, []);

  useEffect(() => {
    const currentSession = session;
    const sharedVideo = roomState?.sharedVideo;
    if (!currentSession || !sharedVideo || sharedVideo.sourceProvider !== "direct") {
      setManifest(null);
      return;
    }
    void loadPlaybackSource(currentSession).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "无法加载播放源");
    });
  }, [loadPlaybackSource, roomState?.sharedVideo, session]);

  const shareDirectVideo = useCallback(async () => {
    const currentSession = sessionRef.current;
    const videoElement = videoRef.current;
    if (!currentSession) {
      setError("请先创建或加入房间");
      return;
    }

    const response = await fetch("/api/web/video/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: directUrl.trim(),
        title: directTitle.trim(),
      }),
    });
    const payload = (await response.json()) as ResolveVideoResponse;
    if (!response.ok || !payload.ok || !payload.data) {
      setError(payload.error?.message ?? "无法解析播放链接");
      return;
    }

    setManifest(payload.data.playbackSource);
    sendMessage({
      type: "video:share",
      payload: {
        memberToken: currentSession.memberToken,
        video: payload.data.video,
        playback: {
          url: payload.data.video.url,
          currentTime: videoElement?.currentTime ?? 0,
          playState: "paused",
          playbackRate: videoElement?.playbackRate ?? 1,
          updatedAt: Date.now(),
          serverTime: 0,
          actorId: currentSession.memberId,
          seq: sequenceRef.current++,
        },
      },
    });
  }, [directTitle, directUrl, sendMessage]);

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

    if (activeVariant.kind === "hls" && !canPlayHlsNatively(video)) {
      if (Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          maxBufferLength: 20,
        });
        hlsRef.current = hls;
        hls.loadSource(activeVariant.url);
        hls.attachMedia(video);
      } else {
        setError("当前浏览器不支持 HLS 播放");
      }
    } else {
      video.src = activeVariant.url;
      video.load();
    }

    return () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [activeVariant]);

  const sendPlaybackUpdate = useCallback(
    (syncIntent?: PlaybackState["syncIntent"], force = false) => {
      const video = videoRef.current;
      const currentSession = sessionRef.current;
      const sharedVideo = roomStateRef.current?.sharedVideo;
      if (!video || !currentSession || !sharedVideo || applyingRemoteRef.current) {
        return;
      }

      const now = Date.now();
      if (!force && now - lastSentAtRef.current < PLAYBACK_SEND_INTERVAL_MS) {
        return;
      }
      lastSentAtRef.current = now;

      const playState: PlaybackState["playState"] = video.paused
        ? "paused"
        : video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
          ? "buffering"
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
            userInitiated: force,
          },
        },
      });
    },
    [sendMessage],
  );

  useEffect(() => {
    const video = videoRef.current;
    const playback = roomState?.playback;
    if (!video || !playback || playback.actorId === session?.memberId) {
      return;
    }

    applyingRemoteRef.current = true;
    video.playbackRate = playback.playbackRate;
    const targetTime = expectedCurrentTime(playback);
    if (Number.isFinite(targetTime) && Math.abs(video.currentTime - targetTime) > SYNC_DRIFT_SECONDS) {
      video.currentTime = Math.max(0, targetTime);
    }

    const applyPlayState = async () => {
      if (playback.playState === "playing") {
        try {
          await video.play();
        } catch {
          setError("浏览器阻止了自动播放，请点一次播放按钮");
        }
      } else {
        video.pause();
      }
      window.setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 150);
    };
    void applyPlayState();
  }, [roomState?.playback, session?.memberId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowPlayingTime(videoRef.current?.currentTime ?? 0);
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const connectionLabel =
    status === "connected"
      ? "已连接"
      : status === "connecting"
        ? "连接中"
        : status === "closed"
          ? "已断开"
          : "未连接";

  return (
    <main className="shell">
      <section className="control-rail" aria-label="房间控制">
        <div className="brand-row">
          <div>
            <p className="eyebrow">BiliSync Web</p>
            <h1>一起看</h1>
          </div>
          <span className={`status-dot status-${status}`}>{connectionLabel}</span>
        </div>

        <label>
          昵称
          <input
            value={displayName}
            maxLength={32}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <div className="room-actions">
          <button type="button" className="primary" onClick={createRoom}>
            <Radio size={18} />
            创建房间
          </button>
          <button type="button" onClick={joinRoom}>
            <LogIn size={18} />
            加入房间
          </button>
        </div>

        <div className="two-fields">
          <label>
            房间号
            <input
              value={roomCodeInput}
              maxLength={6}
              onChange={(event) =>
                setRoomCodeInput(event.target.value.toUpperCase())
              }
            />
          </label>
          <label>
            邀请码
            <input
              value={joinTokenInput}
              onChange={(event) => setJoinTokenInput(event.target.value)}
            />
          </label>
        </div>

        {session ? (
          <div className="room-panel">
            <div>
              <span>房间</span>
              <strong>{session.roomCode}</strong>
            </div>
            {inviteUrl ? (
              <button type="button" title="复制邀请链接" onClick={copyInvite}>
                <Copy size={18} />
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="share-panel">
          <div className="section-title">
            <Link2 size={18} />
            <span>直链播放源</span>
          </div>
          <label>
            HLS / MP4
            <input
              value={directUrl}
              placeholder="https://example.com/video.m3u8"
              onChange={(event) => setDirectUrl(event.target.value)}
            />
          </label>
          <label>
            标题
            <input
              value={directTitle}
              placeholder="本场片名"
              onChange={(event) => setDirectTitle(event.target.value)}
            />
          </label>
          <button type="button" className="primary" onClick={shareDirectVideo}>
            <Share2 size={18} />
            分享到房间
          </button>
        </div>

        <div className="members-panel">
          <div className="section-title">
            <Users size={18} />
            <span>{roomState?.members.length ?? 0} 人在线</span>
          </div>
          <div className="member-list">
            {(roomState?.members ?? []).map((member) => (
              <span key={member.id}>{member.name}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="stage" aria-label="同步播放器">
        <div className="video-frame">
          {activeVariant ? null : (
            <div className="empty-player">
              <LoaderCircle size={22} />
              <span>等待播放源</span>
            </div>
          )}
          <video
            ref={videoRef}
            controls
            playsInline
            poster={manifest?.posterUrl}
            onPlay={() => sendPlaybackUpdate(undefined, true)}
            onPause={() => sendPlaybackUpdate(undefined, true)}
            onSeeking={() => sendPlaybackUpdate("explicit-seek", true)}
            onRateChange={() => sendPlaybackUpdate("explicit-ratechange", true)}
            onTimeUpdate={() => sendPlaybackUpdate()}
          />
        </div>

        <div className="now-bar">
          <div>
            <p>{roomState?.sharedVideo?.title ?? "未分享视频"}</p>
            <span>{activeVariant ? activeVariant.label : "无播放源"}</span>
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

        {error ? <p className="error-line">{error}</p> : null}
      </section>
    </main>
  );
}
