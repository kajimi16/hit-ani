"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { allocateTracks, mergeById, shouldRefill, sortByPlayTime } from "@/lib/danmaku/engine";
import { ensureReadableColor, toCssColor } from "@/lib/danmaku/readable-color";
import { danmakuRoomUrl } from "@/lib/danmaku/ws-url";
import {
  DanmakuLocation,
  type DanmakuDto,
  type DanmakuLocationValue,
} from "@/lib/danmaku/types";

const TRACK_COUNT = 8;
const CANVAS_HEIGHT = TRACK_COUNT * 26;
const TRACK_HEIGHT = 26;
const SPEED_PX_PER_MS = 0.18;
const CHAR_WIDTH = 16;
/** seek 后重建屏幕的时间窗（对齐 Animeko 的 repopulateDistance = 20s）。 */
const REPOPULATE_WINDOW_MS = 20_000;

/**
 * seek 上报的防抖间隔。
 *
 * 拖动进度条时 `seeked` 连续触发，每次都上报等于把网关当压测目标。
 * 取 250ms：既在拖动中不断取消，又让松手后无明显等待感。
 */
const SEEK_DEBOUNCE_MS = 250;
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
  /**
   * seek 上报的防抖计时器。
   *
   * 用 `undefined` 而非 `null`：`clearTimeout(undefined)` 是合法的 no-op，
   * 因此取消时无需守卫（项目规则也禁止对 clearTimeout 加平凡守卫）。
   */
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
  /**
   * 合并弹幕并去重。
   *
   * 补充批次与 WS 推送可能带来已存在的条目，按 `id` 去重后按时间排序 ——
   * 直接覆盖会丢掉先前批次里已渲染的部分。
   * `replace` 用于 WS 首屏回填（那是一次完整的全量快照）。
   */
  const mergeDanmaku = useCallback((incoming: DanmakuDto[], replace = false) => {
    // 合并/去重逻辑抽成纯函数（见 engine.mergeById），此处只管状态更新
    setDanmakus((prev) => (replace ? sortByPlayTime(incoming) : mergeById(prev, incoming)));
  }, []);

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
      mergeDanmaku(body.data, true);
    },
    [episodeId, mergeDanmaku],
  );


  /** 补充状态，防止并发重复请求。 */
  const refillingRef = useRef(false);
  /**
   * 已经请求过的窗口起点。
   *
   * 仅靠 `refillingRef` 不够 —— 实测同一窗口会被请求 3 次
   * （effect 依赖含 `danmakus`，多次状态更新都会重新评估）。
   * 按窗口起点去重后，同一段只请求一次；若该段确实没有更多数据，
   * 也不会反复重试（要等有弹幕新增、末尾前移后才会再请求）。
   */
  const requestedFromRef = useRef<number | null>(null);

  /**
   * 单集弹幕超过服务端单次上限时，播到接近已加载末尾就补充后续。
   *
   * 服务端按时间轴返回前 `defaultLimit` 条 —— 实测 2000 条约覆盖 17 分钟。
   * 超长或弹幕极密的集会落在上限之外；不补充的话，播到后段就没有弹幕
   * （这正是「库里有几千条、播放时只看到一部分」的成因之一）。
   */
  const refillIfNeeded = useCallback(async () => {
    const loaded = danmakusRef.current;
    if (loaded.length === 0 || episodeId === null) return;

    const maxLoadedMs = loaded[loaded.length - 1].playTimeMs;
    // 距已加载末尾不足 60 秒时补充（判定逻辑抽成纯函数以便测试）
    if (!shouldRefill(maxLoadedMs, mediaTimeMs) || refillingRef.current) return;

    // 同一窗口只请求一次
    const fromMs = maxLoadedMs + 1;
    if (requestedFromRef.current === fromMs) return;
    requestedFromRef.current = fromMs;

    refillingRef.current = true;
    try {
      const url = new URL("/api/danmaku", window.location.origin);
      url.searchParams.set("episodeId", String(episodeId));
      url.searchParams.set("fromMs", String(fromMs));
      url.searchParams.set("limit", "2000");
      if (schoolOnly) url.searchParams.set("schoolOnly", "true");

      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { data: DanmakuDto[] };
      mergeDanmaku(body.data);
    } catch {
      /* 补充失败不影响已加载的弹幕 */
    } finally {
      refillingRef.current = false;
    }
  }, [episodeId, mediaTimeMs, schoolOnly, mergeDanmaku]);

  /*
   * 弹幕列表变化时**先**同步到 ref。
   *
   * ⚠️ 这个 effect 必须排在 refill 之前 —— React 按声明顺序执行 effect，
   * 若 refill 先跑，它读到的 `danmakusRef.current` 还是上一轮的值（首轮是空数组），
   * 于是「距末尾不足 60 秒」的判定永远基于旧数据、补充不触发。
   * 实测症状：把首屏截断到 3 条后，播放器不发起任何补充请求。
   */
  useEffect(() => {
    danmakusRef.current = danmakus;
  }, [danmakus]);

  /*
   * 弹幕数据变化后重新评估是否需要补充。
   *
   * 依赖里**必须**有 `danmakus` —— 只依赖 `refillIfNeeded` 是不够的：
   * 那个回调的 deps 是 [episodeId, mediaTimeMs, schoolOnly, mergeDanmaku]，
   * 数据到达不会改变它的 identity，于是 effect 不重跑。
   * 视频暂停时 mediaTimeMs 也不变，补充就永远不会触发。
   * （实测症状：首屏被截断到 3 条后，播放器始终不发起补充请求。）
   */
  useEffect(() => {
    void refillIfNeeded();
  }, [refillIfNeeded, danmakus]);

  useEffect(() => {
    // 没有对应的 BGM 集时（例如 Jellyfin 里多出来的 SP），不加载也不发送弹幕。
    if (episodeId === null) {
      setDanmakus([]);
      setConnection("fallback");
      return;
    }

    let cancelled = false;
    setDanmakus([]);
    // 换了集，之前的窗口记录失效
    requestedFromRef.current = null;
    setError(null);
    setConnection("connecting");

    // 带上当前播放位置 —— 服务端据此决定回填哪一段
    // （不传的话只会从 0 开始取，跳到后段就没有弹幕）
    const roomUrl = danmakuRoomUrl(episodeId, schoolOnly, videoRef.current?.currentTime
      ? videoRef.current.currentTime * 1000
      : 0);

    let socket: WebSocket;
    try {
      socket = new WebSocket(roomUrl);
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
        mergeDanmaku(payload.list, true);
      } else if (payload.type === "add" && payload.danmaku) {
        mergeDanmaku([payload.danmaku]);
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
      // 未发出的 seek 上报要清掉，否则会在旧连接/旧集上触发
      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = undefined;
      socket.close();
    };
  }, [episodeId, schoolOnly, fetchRest, mergeDanmaku]);

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
        // 与列表同一套可读性处理 —— canvas 没有 CSS 层可兜底，
        // 深色弹幕在这里会直接看不见（比列表更严重）。
        ctx.fillStyle = toCssColor(ensureReadableColor(danmaku.color));

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
   * HLS 装配
   *
   * Chrome/Firefox 不原生支持 m3u8（只有 Safari 支持），必须用 hls.js
   * 把播放列表喂给 MSE。直接给 `<video src="...m3u8">` 在这些浏览器上
   * 会静默失败 —— 看起来像「视频加载不出来」，实际是格式不被支持。
   * -------------------------------------------------------------- */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) return;

    const isHls = /\.m3u8(\?|$)/i.test(streamUrl);

    // 非 HLS（mp4 等）直接给 src
    if (!isHls) {
      video.src = streamUrl;
      return;
    }

    // ⚠️ 判断顺序很关键，实测踩过：
    //
    // Chrome 对 `canPlayType("application/vnd.apple.mpegurl")` 返回 **"maybe"**，
    // 但它其实**播不了** HLS（`MediaSource.isTypeSupported` 为 false）。
    // 若先信 canPlayType 走原生路径，Chrome/Edge/Firefox 用户会看到黑屏 ——
    // 且没有任何报错，因为 video 元素只是静默地不加载。
    //
    // 因此优先用 hls.js（凡支持 MSE 的浏览器都能用），
    // 原生只作为老 Safari 的兜底。
    if (!Hls.isSupported()) {
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = streamUrl;
        return;
      }
      setError("当前浏览器不支持 HLS 播放，请更换浏览器或使用外部播放器");
      return;
    }

    const hls = new Hls({
      // 直播/点播都不需要低延迟；默认缓冲更保守，带宽受限的环境更稳
      maxBufferLength: 30,
      enableWorker: true,
    });
    hls.loadSource(streamUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.ERROR, (_event, data) => {
      // 只报致命错误 —— 非致命错误（如单分片失败）hls.js 会自行重试，
      // 弹出来只会干扰用户
      if (data.fatal) {
        setError(
          data.type === Hls.ErrorTypes.NETWORK_ERROR
            ? "视频加载失败：可能是资源失效或跨域限制"
            : "视频播放出错",
        );
      }
    });

    return () => {
      hls.destroy();
    };
  }, [streamUrl]);

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

      /*
       * 通知服务端重新锚定弹幕窗口（**防抖**）。
       *
       * 没有这一步的话，跳到后半段会完全没有弹幕。
       * 但没有防抖的话，用户**拖动**进度条时 `seeked` 会连发几十次 ——
       * 每次都查库、还可能打 dandanplay。因此等停顿后再发一次，
       * 拖动途中不断取消上一条。
       */
      requestedFromRef.current = null;

      clearTimeout(seekTimerRef.current);
      seekTimerRef.current = setTimeout(() => {
        seekTimerRef.current = undefined;
        const socket = socketRef.current;
        if (socket?.readyState !== WebSocket.OPEN) return;

        // 按实际时长钳制：客户端比服务端更清楚边界
        const raw = Math.round(video.currentTime * 1000);
        const durationMs = Number.isFinite(video.duration)
          ? Math.round(video.duration * 1000)
          : null;
        const playTimeMs =
          durationMs === null ? Math.max(0, raw) : Math.min(Math.max(0, raw), durationMs);

        socket.send(JSON.stringify({ type: "seek", playTimeMs }));
      }, SEEK_DEBOUNCE_MS);
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
              ? "bg-success/15 text-success"
              : connection === "fallback"
                ? "bg-warn/15 text-warn"
                : "bg-surface-3 text-ink-muted"
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
          <span className={canInteract ? "" : "text-ink-faint"}>只看本校弹幕</span>
        </label>
      </div>

      {/* 播放器：video 与弹幕 canvas 叠放 */}
      <div className="relative overflow-hidden rounded border border-line bg-black">
        <video
          ref={videoRef}
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
        <p className="alert alert-warn">
          这一集在 Bangumi 里找不到对应集数，已禁用弹幕 ——
          避免把弹幕挂到错误的集上。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
        <span className="font-mono">
          {fmt(mediaTimeMs)} / {durationMs > 0 ? fmt(durationMs) : "--:--"}
        </span>
        <span>已加载弹幕 {danmakus.length} 条</span>
        <span className="text-ink-faint">
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
          className="input flex-1 disabled:opacity-50"
        />
        <select
          value={position}
          onChange={(event) => setPosition(Number(event.target.value) as DanmakuLocationValue)}
          className="input w-auto py-1.5"
        >
          <option value={DanmakuLocation.Normal}>滚动</option>
          <option value={DanmakuLocation.Top}>顶部</option>
          <option value={DanmakuLocation.Bottom}>底部</option>
        </select>
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canInteract || episodeId === null || draft.trim().length === 0}
          className="rounded bg-accent-strong px-5 py-2 text-sm font-medium text-white hover:bg-accent disabled:opacity-40"
        >
          发送
        </button>
      </div>

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}
    </section>
  );
}
