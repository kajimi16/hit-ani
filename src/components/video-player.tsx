"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { allocateTracks, sortByPlayTime } from "@/lib/danmaku/engine";
import {
  DanmakuLocation,
  type DanmakuDto,
  type DanmakuLocationValue,
} from "@/lib/danmaku/types";

const WS_BASE = process.env.NEXT_PUBLIC_DANMAKU_WS_URL ?? "ws://localhost:3102";
const TRACK_COUNT = 8;
const CANVAS_HEIGHT = TRACK_COUNT * 26;
const TRACK_HEIGHT = 26;
const SPEED_PX_PER_MS = 0.18;
const CHAR_WIDTH = 16;
/** seek 后重建屏幕的时间窗（对齐 Animeko 的 repopulateDistance = 20s）。 */
const REPOPULATE_WINDOW_MS = 20_000;
/** 播放进度上报节流。 */
const PROGRESS_REPORT_INTERVAL_MS = 15_000;

interface Props {
  /**
   * 用于弹幕的 BGM episodeId。
   * `null` 表示当前播放的集在 BGM 里找不到对应 —— 此时禁用弹幕，
   * 而不是用一个错误的 id（那会把弹幕挂到别的集上）。
   */
  episodeId: number | null;
  title: string;
  /** 直连 Jellyfin 的播放地址（含用户自己的 token）。 */
  streamUrl: string;
  /** 从第几毫秒续播。 */
  startAtMs?: number;
  canInteract: boolean;
  /** 进度回调（本地落库 + BGM 回写由调用方决定）。 */
  onProgress?: (positionMs: number, durationMs: number) => void;
}

/**
 * 播放器 + 弹幕叠加层。
 *
 * 核心设计（依据 Animeko 源码调研，见 docs/MEDIA.md §4）——
 * **两个时钟必须分离**：
 *
 * | 时钟 | 来源 | 决定 |
 * |---|---|---|
 * | 媒体时钟 | `video.currentTime` | 该发哪条弹幕 |
 * | 渲染时钟 | `requestAnimationFrame` 时间戳（墙钟） | 弹幕滚了多远 |
 *
 * 如果用 `video.currentTime` 算位移，倍速播放时弹幕会跟着飞走 —— Animeko 明确
 * 不做这种补偿（倍速下弹幕视觉速度保持恒定）。暂停时冻结渲染时钟。
 */
export default function VideoPlayer({
  episodeId,
  title,
  streamUrl,
  startAtMs = 0,
  canInteract,
  onProgress,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);

  const [danmakus, setDanmakus] = useState<DanmakuDto[]>([]);
  /** rAF 循环里读取的弹幕列表 —— 用 ref 避免把整个列表塞进 effect 依赖。 */
  const danmakusRef = useRef<DanmakuDto[]>([]);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "open" | "fallback">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [position, setPosition] = useState<DanmakuLocationValue>(DanmakuLocation.Normal);

  /** 弹幕渲染时钟（墙钟毫秒）。播放时推进，暂停时冻结。 */
  const renderClockRef = useRef(0);
  /** 最近一次渲染时钟与媒体时间的对应关系，用于 seek 后重建。 */
  const anchorRef = useRef({ mediaMs: 0, renderMs: 0 });
  const [mediaTimeMs, setMediaTimeMs] = useState(startAtMs);
  const [durationMs, setDurationMs] = useState(0);
  const [paused, setPaused] = useState(true);
  /** rAF 循环里读的 paused —— 用 ref 避免把启动/停止逻辑绑到每次状态变化。 */
  const pausedRef = useRef(true);
  /** rAF 最近一次运行的时间戳，用于判断它是否被浏览器节流。 */
  const rafLastRunRef = useRef(0);

  /* -------------------------------------------------------------- *
   * 弹幕拉取（WebSocket，失败降级 REST）
   * -------------------------------------------------------------- */
  const fetchRest = useCallback(
    async (onlySchool: boolean) => {
      const url = new URL("/api/danmaku", window.location.origin);
      url.searchParams.set("episodeId", String(episodeId));
      url.searchParams.set("limit", "2000");
      if (onlySchool) url.searchParams.set("schoolOnly", "true");
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `拉取失败（${response.status}）`);
      }
      const body = (await response.json()) as { data: DanmakuDto[] };
      setDanmakus(sortByPlayTime(body.data));
    },
    [episodeId],
  );

  useEffect(() => {
    // 没有对应的 BGM 集时（例如 Jellyfin 里多出来的 SP），不加载也不发送弹幕。
    if (episodeId === null) {
      setDanmakus([]);
      setConnection("fallback");
      return;
    }

    let cancelled = false;
    setDanmakus([]);
    setError(null);
    setConnection("connecting");

    const url = new URL(`${WS_BASE}/danmaku/room/${episodeId}`);
    if (schoolOnly) url.searchParams.set("schoolOnly", "true");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setConnection("fallback");
      void fetchRest(schoolOnly).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    socketRef.current = socket;

    socket.addEventListener("open", () => !cancelled && setConnection("open"));
    socket.addEventListener("message", (event) => {
      if (cancelled) return;
      const payload = JSON.parse(String(event.data)) as {
        type: string;
        list?: DanmakuDto[];
        danmaku?: DanmakuDto;
        message?: string;
      };
      if (payload.type === "repopulate" && payload.list) {
        setDanmakus(sortByPlayTime(payload.list));
      } else if (payload.type === "add" && payload.danmaku) {
        setDanmakus((prev) =>
          prev.some((d) => d.id === payload.danmaku!.id)
            ? prev
            : sortByPlayTime([...prev, payload.danmaku!]),
        );
      } else if (payload.type === "error" && payload.message) {
        setError(payload.message);
      }
    });
    socket.addEventListener("error", () => {
      if (cancelled) return;
      setConnection("fallback");
      void fetchRest(schoolOnly).catch(() => undefined);
    });

    return () => {
      cancelled = true;
      socketRef.current = null;
      socket.close();
    };
  }, [episodeId, schoolOnly, fetchRest]);

  /** 弹幕列表变化时同步到 ref（rAF 循环读它）。 */
  useEffect(() => {
    danmakusRef.current = danmakus;
  }, [danmakus]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  /* -------------------------------------------------------------- *
   * 渲染时钟：rAF 推进，**暂停时冻结**；绘制也在同一循环里
   * -------------------------------------------------------------- */
  useEffect(() => {
    /** 绘制一帧：弹幕位置是渲染时钟的纯函数，不做增量积分（避免累积误差）。 */
    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      if (width <= 0) return;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = CANVAS_HEIGHT * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, CANVAS_HEIGHT);

      const { mediaMs: anchorMedia, renderMs: anchorRender } = anchorRef.current;
      // 当前渲染时刻对应的媒体时间 = 锚点媒体时间 + 已流逝渲染时间。
      // 倍速下两者不再一致 —— 这正是刻意的：弹幕视觉速度不随倍速变化。
      const renderMediaMs = anchorMedia + (renderClockRef.current - anchorRender);

      const active = danmakusRef.current.filter(
        (d) =>
          d.playTimeMs <= renderMediaMs &&
          d.playTimeMs >= renderMediaMs - REPOPULATE_WINDOW_MS,
      );

      const assignments = allocateTracks(active, {
        trackCount: TRACK_COUNT,
        viewportWidth: width,
        charWidth: CHAR_WIDTH,
        speedPxPerMs: SPEED_PX_PER_MS,
      });

      ctx.font = "16px system-ui, sans-serif";
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 3;

      for (const { danmaku, track } of assignments) {
        const elapsed = renderMediaMs - danmaku.playTimeMs;
        if (elapsed < 0) continue;

        const textWidth = Array.from(danmaku.text).length * CHAR_WIDTH;
        ctx.fillStyle = `#${danmaku.color.toString(16).padStart(6, "0")}`;

        if (danmaku.location === DanmakuLocation.Normal) {
          const x = width - elapsed * SPEED_PX_PER_MS;
          if (x + textWidth < 0) continue;
          ctx.fillText(danmaku.text, x, track * TRACK_HEIGHT + 18);
        } else {
          const x = (width - textWidth) / 2;
          const y =
            danmaku.location === DanmakuLocation.Top
              ? 16 + track * TRACK_HEIGHT
              : CANVAS_HEIGHT - 10 - track * TRACK_HEIGHT;
          ctx.fillText(danmaku.text, x, y);
        }
      }
      ctx.shadowBlur = 0;
    };

    // 轨道一：requestAnimationFrame —— 正常情况下的平滑绘制（~60fps）
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      if (!pausedRef.current) renderClockRef.current += delta;
      rafLastRunRef.current = now;
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // 轨道二：定时器兜底 —— rAF 被浏览器节流时（标签页切到后台、无头浏览器）
    // 仍推进渲染时钟并重绘。否则回到前台时弹幕会严重落后于视频进度。
    // 这与 Animeko 的 `withFrameNanos` + `delay(1000)` 双轨做法一致。
    const fallback = setInterval(() => {
      const sinceRaf = performance.now() - rafLastRunRef.current;
      if (sinceRaf < 500) return; // rAF 正常，交给它处理，避免双重计时
      if (!pausedRef.current) renderClockRef.current += 1000;
      draw();
    }, 1000);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(fallback);
    };
  }, []);

  /* -------------------------------------------------------------- *
   * 媒体时钟：由 video 事件驱动（低频，仅用于「该发哪条弹幕」）
   * -------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    setPaused(video.paused);
    setDurationMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);

    const syncTime = () => {
      const ms = video.currentTime * 1000;
      setMediaTimeMs(ms);
      anchorRef.current = { mediaMs: ms, renderMs: renderClockRef.current };
    };

    const onPlay = () => {
      // 重新锚定：暂停期间渲染时钟没走，媒体时间可能已变
      anchorRef.current = { mediaMs: video.currentTime * 1000, renderMs: renderClockRef.current };
      setPaused(false);
    };
    const onPause = () => setPaused(true);
    const onSeeked = () => {
      // seek 后清屏重建：把媒体时间差 1:1 映射到渲染时钟差
      anchorRef.current = { mediaMs: video.currentTime * 1000, renderMs: renderClockRef.current };
      syncTime();
    };
    const onLoadedMetadata = () => {
      setDurationMs(Number.isFinite(video.duration) ? video.duration * 1000 : 0);
      if (startAtMs > 0) video.currentTime = startAtMs / 1000;
    };
    const onTimeUpdate = () => setMediaTimeMs(video.currentTime * 1000);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("ended", onPause);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onPause);
    };
  }, [startAtMs, streamUrl]);

  /* -------------------------------------------------------------- *
   * 进度上报（节流）
   * -------------------------------------------------------------- */
  const lastReportRef = useRef(0);
  useEffect(() => {
    if (!onProgress || paused) return;
    const now = Date.now();
    if (now - lastReportRef.current < PROGRESS_REPORT_INTERVAL_MS) return;
    lastReportRef.current = now;
    onProgress(mediaTimeMs, durationMs);
  }, [mediaTimeMs, durationMs, paused, onProgress]);

  /* -------------------------------------------------------------- *
   * 弹幕绘制：位置是渲染时钟的纯函数（无累积误差）
   *
   * 绘制挂在 rAF 里而不是 effect 依赖上 —— `timeupdate` 只有约 4Hz，
   * 靠它驱动会让弹幕明显卡顿。这里每帧读 ref，不依赖 React 渲染节奏。
   * -------------------------------------------------------------- */
  /* -------------------------------------------------------------- *
   * 发送弹幕
   * -------------------------------------------------------------- */
  const send = async () => {
    const text = draft.trim();
    if (!text || !canInteract || episodeId === null) return;
    const playTimeMs = Math.round((videoRef.current?.currentTime ?? 0) * 1000);

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "send", playTimeMs, text, location: position }));
      setDraft("");
      return;
    }
    try {
      const response = await fetch("/api/danmaku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, playTimeMs, text, location: position }),
      });
      const body = (await response.json()) as { data?: DanmakuDto; error?: string };
      if (!response.ok) throw new Error(body.error ?? "发送失败");
      if (body.data) setDanmakus((prev) => sortByPlayTime([...prev, body.data!]));
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const fmt = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            connection === "open"
              ? "bg-emerald-900/60 text-emerald-300"
              : connection === "fallback"
                ? "bg-amber-900/60 text-amber-300"
                : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {connection === "open" ? "弹幕实时" : connection === "fallback" ? "弹幕 REST" : "连接中…"}
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schoolOnly}
            disabled={!canInteract}
            onChange={(event) => setSchoolOnly(event.target.checked)}
            className="size-4 accent-sky-500"
          />
          <span className={canInteract ? "" : "text-neutral-600"}>只看本校弹幕</span>
        </label>
      </div>

      {/* 播放器：video 与弹幕 canvas 叠放 */}
      <div className="relative overflow-hidden rounded border border-neutral-800 bg-black">
        <video
          ref={videoRef}
          src={streamUrl}
          controls
          playsInline
          preload="metadata"
          className="block aspect-video w-full bg-black"
        />
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: CANVAS_HEIGHT }}
          className="pointer-events-none absolute left-0 top-0"
        />
      </div>

      {episodeId === null && (
        <p className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          这一集在 Bangumi 里找不到对应集数，已禁用弹幕 ——
          避免把弹幕挂到错误的集上。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-500">
        <span className="font-mono">
          {fmt(mediaTimeMs)} / {durationMs > 0 ? fmt(durationMs) : "--:--"}
        </span>
        <span>已加载弹幕 {danmakus.length} 条</span>
        <span className="text-neutral-600">
          视频由你的 Jellyfin 服务器直连播放，不经过本平台
        </span>
      </div>

      <div className="flex gap-3">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          disabled={!canInteract || episodeId === null}
          placeholder={
            episodeId === null
              ? "本集未对应到 Bangumi 集数，无法发送弹幕"
              : canInteract
                ? "发一条弹幕（回车发送）"
                : "登录后可发送弹幕"
          }
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500 disabled:opacity-50"
        />
        <select
          value={position}
          onChange={(event) => setPosition(Number(event.target.value) as DanmakuLocationValue)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
        >
          <option value={DanmakuLocation.Normal}>滚动</option>
          <option value={DanmakuLocation.Top}>顶部</option>
          <option value={DanmakuLocation.Bottom}>底部</option>
        </select>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canInteract || episodeId === null || draft.trim().length === 0}
          className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          发送
        </button>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
