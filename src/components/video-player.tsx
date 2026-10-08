"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { allocateTracks, mergeById, shouldRefill, sortByPlayTime } from "@/lib/danmaku/engine";
import { contrastOutlineFor, toCssColor } from "@/lib/danmaku/readable-color";
import DanmakuSettings from "@/components/danmaku-settings";
import {
  DEFAULT_DANMAKU_STYLE,
  danmakuLayout,
  shouldRenderDanmaku,
  type DanmakuStyle,
} from "@/lib/danmaku/style";
import { danmakuRoomUrl } from "@/lib/danmaku/ws-url";
import {
  DanmakuLocation,
  type DanmakuDto,
  type DanmakuLocationValue,
} from "@/lib/danmaku/types";
import {
  DEFAULT_SPEED,
  NEXT_COUNTDOWN_SECONDS,
  clampTime,
  countdownRemaining,
  formatSpeed,
  ownsKeyboard,
  resolveShortcut,
  seekTargetFromDrag,
  shouldAutoAdvance,
  readPlayerPrefs,
  stepSpeed,
  writePlayerPrefs,
  type ShortcutAction,
  type TimerHandle,
} from "@/lib/player/controls";

/*
 * 弹幕的绘制参数（轨道数、行高、速度、字宽）**全部由用户的显示设置决定**，
 * 见 `danmakuLayout()`。这里不再有硬编码常量 —— 早先字号与速度是写死的，
 * 手机上明显偏小且无法调整。
 */
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
  /**
   * 弹幕显示样式（字号/透明度/区域/速度/开关）。
   *
   * 不传时用默认值 —— 与改动前的硬编码等价，因此老调用方观感不变。
   */
  danmakuStyle?: DanmakuStyle;
  /**
   * 播放到片尾时的回调（自动连播用）。
   *
   * 不传则**不显示**任何「下一集」界面 —— 没法换集时给倒计时是骗人。
   * 「下一集是哪一集」由调用方决定，播放器不持有剧集列表。
   */
  onEnded?: () => void;
  /** 是否存在下一集。没有时播完即停，不进入倒计时。 */
  hasNext?: boolean;
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
  danmakuStyle = DEFAULT_DANMAKU_STYLE,
  onEnded,
  hasNext = false,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  /*
   * 弹幕样式：面板改的是**内部状态**，而不是回传给调用方 —— 播放器是弹幕
   * 显示的唯一归属者，样式也只影响它。调用方传 `danmakuStyle` 只作为初始值。
   *
   * `danmakuStyleRef` 是给 `draw()` 读的：它所在的 effect 依赖是 `[]`
   * （只挂一次，含 WebSocket 与 rAF），直接闭包捕获样式会永远停在首帧的值。
   */
  const [activeStyle, setActiveStyle] = useState<DanmakuStyle>(danmakuStyle);
  const danmakuStyleRef = useRef<DanmakuStyle>(danmakuStyle);
  useEffect(() => {
    danmakuStyleRef.current = activeStyle;
  }, [activeStyle]);
  useEffect(() => {
    setActiveStyle(danmakuStyle);
  }, [danmakuStyle]);

  /** 画布尺寸随样式变化（区域小则画布也矮，不留一块空白挡着视频）。 */
  const layout = danmakuLayout(activeStyle);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  /**
   * seek 上报的防抖计时器。
   *
   * 用 `undefined` 而非 `null`：`clearTimeout(undefined)` 是合法的 no-op，
   * 因此取消时无需守卫（项目规则也禁止对 clearTimeout 加平凡守卫）。
   */
  const seekTimerRef = useRef<TimerHandle | undefined>(undefined);

  const [danmakus, setDanmakus] = useState<DanmakuDto[]>([]);
  /** rAF 循环里读取的弹幕列表 —— 用 ref 避免把整个列表塞进 effect 依赖。 */
  const danmakusRef = useRef<DanmakuDto[]>([]);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "open" | "fallback">("connecting");

  /* ---------------------------------------------------------------- *
   * 自绘控件的状态
   * ---------------------------------------------------------------- */

  /**
   * 播放倍速。
   *
   * 与弹幕显示样式一样，**刻意放在组件内部**：它只影响这一台机器上的这次
   * 播放，回传给调用方既没有用处，也会让条目页多一份无意义的 state。
   */
  const [speed, setSpeed] = useState<number>(DEFAULT_SPEED);
  /**
   * 快捷键回调里读的倍速。
   *
   * 键盘监听必须**只挂一次** —— 依赖 `speed` 状态会让每次调速都重新注册
   * 文档级监听，而重新注册的间隙里按下的键会丢。用 ref 读最新值。
   */
  const speedRef = useRef<number>(DEFAULT_SPEED);
  /** 自动连播开关的当前值 —— `applySpeed` 写偏好时要把它一起带上。 */
  const autoNextRef = useRef(true);
  const [muted, setMuted] = useState(false);
  /** 拖动进度条时的**预览**位置：拖动过程中不真的 seek，松手才跳。 */
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  /** 拖动横向手势时的目标位置预览。 */
  const [gestureScrubMs, setGestureScrubMs] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [autoNext, setAutoNext] = useState(true);
  /**
   * 播完之后停顿的剩余秒数；`null` = 不在倒计时。
   *
   * 用「剩余秒数」而不是「已过去多久」—— 倒计时界面要显示的是它，
   * 而每秒重算 `NEXT_COUNTDOWN_SECONDS - elapsed` 需要在渲染里做减法，
   * 一旦忘了就不显示或显示负数。
   */
  const [countdown, setCountdown] = useState<number | null>(null);
  /** 控制条在暂停/鼠标移入时显示；播放中淡出。 */
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControlsTimerRef = useRef<TimerHandle | undefined>(undefined);

  /**
   * 播完时该做什么。
   *
   * 用 ref 而不是把它塞进媒体时钟 effect 的依赖：那个 effect 依赖
   * `[startAtMs, streamUrl]`，把 `autoNext`/`hasNext` 加进去会让每次改动
   * 都重新绑定全部监听 —— 而监听重绑期间的事件会丢。
   */
  const endedHandlerRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    endedHandlerRef.current = () => {
      /*
       * 三个条件缺一不可（见 `shouldAutoAdvance`）：关了自动连播、
       * 没有下一集、或只是暂停/切走，都不该弹倒计时。
       */
      if (shouldAutoAdvance({ enabled: autoNext, hasNext, ended: true })) {
        countdownStartRef.current = Date.now();
        setCountdown(NEXT_COUNTDOWN_SECONDS);
      }
    };
  }, [autoNext, hasNext]);

  /** 拖动手势的起点。非 null 表示正在拖。 */
  /**
   * 单击/双击消歧的计时器。
   *
   * 浏览器在双击时**也会**先发一次 `click`，所以不能「click 就暂停」——
   * 那样双击全屏会顺带暂停。改成：单击延迟 220ms 再执行，
   * 若期间来了双击就取消它（`dblclick` 必然晚于第一个 `click`）。
   */
  const clickTimerRef = useRef<TimerHandle | undefined>(undefined);

  /** 播放器外框 —— 全屏与手势都作用在它身上。 */
  const shellRef = useRef<HTMLDivElement | null>(null);

  const gestureRef = useRef<{
    x: number;
    y: number;
    startMs: number;
    /** 已判定为横向拖动（用于忽略纵向抖动）。 */
    axis: "unknown" | "horizontal" | "vertical";
  } | null>(null);
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

      // 每帧读最新样式 —— 用户拖动滑块应立刻看到效果，而不是等重挂载
      const style = danmakuStyleRef.current;
      const layout = danmakuLayout(style);

      // 画布尺寸随「显示区域」变化，因此必须逐帧核对而不是只设一次
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(layout.canvasHeight * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, layout.canvasHeight);

      // 关掉弹幕时整帧不画（不是把透明度调到 0 —— 那还在占用绘制）
      if (!style.enabled) return;

      const { mediaMs: anchorMedia, renderMs: anchorRender } = anchorRef.current;
      // 当前渲染时刻对应的媒体时间 = 锚点媒体时间 + 已流逝渲染时间。
      // 倍速下两者不再一致 —— 这正是刻意的：弹幕视觉速度不随倍速变化。
      const renderMediaMs = anchorMedia + (renderClockRef.current - anchorRender);

      const active = danmakusRef.current.filter(
        (d) =>
          d.playTimeMs <= renderMediaMs &&
          d.playTimeMs >= renderMediaMs - REPOPULATE_WINDOW_MS &&
          // 按类型开关过滤：关了顶弹幕就不该为它分配轨道（否则下方弹幕会被挤走）
          shouldRenderDanmaku(style, d.location),
      );

      const assignments = allocateTracks(active, {
        trackCount: layout.trackCount,
        viewportWidth: width,
        charWidth: layout.charWidth,
        speedPxPerMs: layout.speedPxPerMs,
      });

      ctx.font = `${style.fontSize}px system-ui, sans-serif`;
      // 透明度整体作用于这一帧的所有弹幕
      ctx.globalAlpha = style.opacity;
      /*
       * canvas 上没有 CSS 层可以兜底，而且背景是**视频画面** —— 亮度完全
       * 不可知（可能全白也可能全黑）。因此这里**不改弹幕颜色**：
       *
       * - 用 `ensureReadableColor` 需要已知背景色，视频画面给不出；
       * - 改色还会破坏发送者的意图（有人特意为亮画面选了深色）。
       *
       * 改为描边与字色亮度相反：亮字配暗描边、暗字配亮描边。
       * 这对任意画面都成立，且保留原色。
       */
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;

      for (const { danmaku, track } of assignments) {
        const elapsed = renderMediaMs - danmaku.playTimeMs;
        if (elapsed < 0) continue;

        const textWidth = Array.from(danmaku.text).length * layout.charWidth;
        ctx.strokeStyle = contrastOutlineFor(danmaku.color);
        ctx.fillStyle = toCssColor(danmaku.color);

        if (danmaku.location === DanmakuLocation.Normal) {
          const x = width - elapsed * layout.speedPxPerMs;
          if (x + textWidth < 0) continue;
          const y = track * layout.trackHeight + layout.trackHeight * 0.69;
          ctx.strokeText(danmaku.text, x, y);
          ctx.fillText(danmaku.text, x, y);
        } else {
          const x = (width - textWidth) / 2;
          const y =
            danmaku.location === DanmakuLocation.Top
              ? layout.trackHeight * 0.62 + track * layout.trackHeight
              : layout.canvasHeight - layout.trackHeight * 0.38 - track * layout.trackHeight;
          ctx.strokeText(danmaku.text, x, y);
          ctx.fillText(danmaku.text, x, y);
        }
      }
    };

    /*
     * 轨道一：requestAnimationFrame —— 正常情况下的平滑绘制（~60fps）
     *
     * ⚠️ 这里**不**受 `prefers-reduced-motion` 影响，是有意的：
     * 弹幕横向滚动**就是内容本身**，不滚动等于没有弹幕。该偏好针对的是
     * 装饰性动画（位移、缩放、视差），而不是「视频在播放、弹幕在飘」这类
     * 用户自己主动发起的媒体播放。
     *
     * 同类豁免还有 `<video>` 的播放本身。别把它「修」成静态。
     */
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
      /*
       * 重新应用倍速与音量：换源（或 hls.js 重新 attach）之后浏览器会把
       * `playbackRate` 复位成 1，而界面上的「1.5×」还在 —— 状态与实际的
       * 不一致是最难查的那种 bug。音量同理（部分浏览器会复位）。
       */
      video.playbackRate = speedRef.current;
    };
    const onTimeUpdate = () => setMediaTimeMs(video.currentTime * 1000);

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onPause);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    /*
     * `ended` 与 `pause` 都要做：`ended` 时视频已暂停但 `pause` 事件不一定
     * 触发，只挂 `pause` 会让「播完」被当成「用户按了暂停」，控制条永远显示。
     */
    const onEndedEvent = () => {
      onPause();
      endedHandlerRef.current();
    };
    video.addEventListener("ended", onEndedEvent);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onPause);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("ended", onEndedEvent);
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

  /* -------------------------------------------------------------- *
   * 自绘控件的动作
   * -------------------------------------------------------------- */

  /**
   * 跳转到指定毫秒。
   *
   * 用 `clampTime` 钳制而不是直接赋值：`duration` 在元数据到达前是 `NaN`，
   * 直接 `video.currentTime = NaN` 会把播放位置弄坏（且不报错）。
   */
  const seekTo = useCallback((ms: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = clampTime(ms, video.duration * 1000) / 1000;
  }, []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => setError("浏览器拒绝了自动播放"));
    else video.pause();
  }, []);

  const applySpeed = useCallback(
    (next: number) => {
      setSpeed(next);
      // ref 必须与状态同步更新：快捷键回调读的是它
      speedRef.current = next;
      if (videoRef.current) videoRef.current.playbackRate = next;
      writePlayerPrefs({ autoNext: autoNextRef.current, speed: next });
    },
    [],
  );

  const nudgeSpeed = useCallback(
    (delta: number) => applySpeed(stepSpeed(speedRef.current, delta)),
    [applySpeed],
  );

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  }, []);

  const nudgeVolume = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    // 调音量时自动取消静音 —— 否则「按了没反应」会被当成坏了
    video.muted = false;
    setMuted(false);
    video.volume = Math.min(1, Math.max(0, video.volume + delta));
  }, []);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void shell.requestFullscreen().catch(() => undefined);
  }, []);

  /**
   * 执行一条快捷键。
   *
   * 解析在 `resolveShortcut`（纯函数、有测试），这里只做副作用。
   */
  const runShortcut = useCallback(
    (action: ShortcutAction) => {
      switch (action.kind) {
        case "toggle-play":
          togglePlay();
          return;
        case "seek-by": {
          const video = videoRef.current;
          if (video) seekTo((video.currentTime + action.seconds) * 1000);
          return;
        }
        case "speed":
          nudgeSpeed(action.delta);
          return;
        case "speed-reset":
          applySpeed(DEFAULT_SPEED);
          return;
        case "volume":
          nudgeVolume(action.delta);
          return;
        case "toggle-mute":
          toggleMute();
          return;
        case "toggle-fullscreen":
          toggleFullscreen();
          return;
      }
    },
    [applySpeed, nudgeSpeed, nudgeVolume, seekTo, toggleFullscreen, toggleMute, togglePlay],
  );

  /**
   * 快捷键。
   *
   * **挂在播放器外框上，不挂 `document`。** 挂 document 会让「播放器只是
   * 挂在页面上」就劫持整页的空格与方向键 —— 条目页有一屏又一屏的章节、
   * 评论、影评，用户按空格想往下翻，结果是视频暂停/播放，
   * 而且**没有任何提示**说明是谁拿走了按键。
   *
   * 为了让焦点能落在容器上：容器设了 `tabIndex={-1}`，并且在 `pointerdown`
   * 时主动 `focus()`（点视频任意位置即可）。全屏时容器本身就是
   * `fullscreenElement`，按键仍然冒泡到它，因此全屏下同样有效。
   *
   * `ownsKeyboard` 是安全不变量：输入框（弹幕框就在同一组件里）与已聚焦的
   * 按钮都必须自己保留按键 —— 见 `lib/player/controls.ts`。
   */
  const onShellKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const action = resolveShortcut({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        targetOwnsKeys: ownsKeyboard(event.target as { tagName?: string; isContentEditable?: boolean }),
      });
      if (!action) return;
      // 空格会滚动页面、方向键会滚动 —— 既然我们接管了就必须阻止默认
      event.preventDefault();
      runShortcut(action);
    },
    [runShortcut],
  );

  /* ---- 偏好：挂载后才读 localStorage（SSR 阶段没有它）---- */
  useEffect(() => {
    const prefs = readPlayerPrefs();
    /*
     * **ref 必须在 `applySpeed` 之前赋值** —— `applySpeed` 会把两个偏好
     * 一起写回存储，而它读的是 `autoNextRef.current`。漏掉这一行的话，
     * 存着 `autoNext: false` 的用户每次挂载都会被改回 `true`：
     * 持久化形同虚设，而且**没有任何报错**（这正是当初加持久化要修的
     * 那个「设置每次被重置」问题，只是换了个地方复发）。
     */
    autoNextRef.current = prefs.autoNext;
    setAutoNext(prefs.autoNext);
    applySpeed(prefs.speed);
  }, [applySpeed]);

  /* ---- 全屏状态 ---- */
  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === shellRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  /* ---- 控制条自动隐藏 ---- */
  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideControlsTimerRef.current);
    hideControlsTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
  }, []);
  useEffect(() => {
    clearTimeout(hideControlsTimerRef.current);
    // 暂停时**不**隐藏：用户正要操作，把控制条藏掉是最烦人的
    if (paused) setControlsVisible(true);
    else showControlsTemporarily();
    return () => clearTimeout(hideControlsTimerRef.current);
  }, [paused, showControlsTemporarily]);

  /* ---- 自动连播倒计时 ---- */
  const advanceToNext = useCallback(() => {
    setCountdown(null);
    onEnded?.();
  }, [onEnded]);

  /**
   * 倒计时起点（墙上时钟）。
   *
   * 剩余秒数**由起点推算**，而不是每次 tick 减一 —— 后台标签页里
   * `setInterval` 会被浏览器节流到约每分钟一次，纯递减会让倒计时
   * 比真实时间慢得多，看起来像卡死了。
   */
  const countdownStartRef = useRef(0);
  /**
   * 是否正在倒计时。
   *
   * 抽成变量是为了让 effect 的依赖数组**可被静态检查**：写
   * `[countdown === null]` 会被 `exhaustive-deps` 判为复杂表达式；
   * 直接依赖 `countdown` 又会让计时器每秒被重建一次（重建的间隙会吃掉 tick）。
   */
  const countingDown = countdown !== null;

  useEffect(() => {
    if (!countingDown) return;
    const timer = setInterval(() => {
      const left = countdownRemaining(Date.now() - countdownStartRef.current);
      if (left <= 0) {
        advanceToNext();
        return;
      }
      setCountdown(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [countingDown, advanceToNext]);

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            connection === "open"
              ? "bg-tertiary-container text-tertiary"
              : connection === "fallback"
                ? "bg-secondary-container text-secondary"
                : "bg-surface-container-high text-on-surface-variant"
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
          <span className={canInteract ? "" : "text-on-surface-variant/70"}>只看本校弹幕</span>
        </label>
      </div>

      {/*
        播放器：video + 弹幕 canvas + 手势层 + 自绘控制条。

        **刻意不用 `<video controls>`** —— 原生控件是浏览器自绘的，
        CSS 改不动、无法加倍速菜单，而且它会吞掉点击事件导致手势失效。
        代价是我们必须自己保证无障碍：下面的控件全部是原生 `button` /
        `input[type=range]`，键盘与读屏可用（自绘成 `div` 会全部失效）。

        层级自下而上：video → canvas → 手势层 → 控制条 → 倒计时。
        手势层铺满视频区，因此控制条**必须**放在它之后（DOM 顺序即层级），
        否则点击按钮会先被手势层吃掉。
      */}
      <div
        ref={shellRef}
        /*
         * `tabIndex={-1}` 让容器可被**程序化**聚焦（不进入 Tab 顺序）——
         * 快捷键监听挂在它身上，所以焦点必须能落到这里。点视频任意位置
         * 即聚焦，这也是「我要开始操作播放器了」的自然信号。
         */
        tabIndex={-1}
        onKeyDown={onShellKeyDown}
        onPointerDown={() => shellRef.current?.focus()}
        className="player-shell group relative overflow-hidden rounded border border-outline-variant bg-black outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onMouseMove={showControlsTemporarily}
        onMouseLeave={() => !paused && setControlsVisible(false)}
      >
        <video
          ref={videoRef}
          playsInline
          preload="metadata"
          className="block aspect-video w-full bg-black"
        />
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: layout.canvasHeight }}
          className="pointer-events-none absolute left-0 top-0"
        />

        {/*
          手势层。`touch-none` 关掉浏览器自带的滚动/缩放，否则手机上横向拖动
          会被识别成页面滚动，`pointermove` 收不到。
        */}
        <div
          className="absolute inset-0 touch-none"
          role="presentation"
          onPointerDown={(event) => {
            const video = videoRef.current;
            if (!video) return;
            gestureRef.current = {
              x: event.clientX,
              y: event.clientY,
              startMs: video.currentTime * 1000,
              axis: "unknown",
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const gesture = gestureRef.current;
            const video = videoRef.current;
            if (!gesture || !video) return;

            const dx = event.clientX - gesture.x;
            const dy = event.clientY - gesture.y;

            // 先判定主轴，避免手指轻微抖动时位置预览来回跳
            if (gesture.axis === "unknown") {
              if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return;
              gesture.axis = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
              if (gesture.axis === "vertical") {
                // 纵向手势不参与定位，直接放弃这次
                gestureRef.current = null;
                return;
              }
            }

            const width = event.currentTarget.clientWidth || 1;
            setGestureScrubMs(
              seekTargetFromDrag({
                startMs: gesture.startMs,
                dragRatio: dx / width,
                durationMs: video.duration * 1000,
              }),
            );
          }}
          onPointerUp={() => {
            const gesture = gestureRef.current;
            gestureRef.current = null;
            if (gestureScrubMs !== null) {
              seekTo(gestureScrubMs);
              setGestureScrubMs(null);
              return;
            }
            setGestureScrubMs(null);
            // `axis` 仍是 unknown = 没有位移 → 这是一次单击（而非拖动）
            if (gesture?.axis !== "unknown") return;
            clearTimeout(clickTimerRef.current);
            clickTimerRef.current = setTimeout(() => togglePlay(), 220);
          }}
          onPointerCancel={() => {
            gestureRef.current = null;
            setGestureScrubMs(null);
          }}
          onDoubleClick={() => {
            clearTimeout(clickTimerRef.current);
            toggleFullscreen();
          }}
        />

        {/* 拖动定位的实时预览 —— 不显示的话用户不知道会跳到哪里 */}
        {gestureScrubMs !== null && (
          <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded bg-scrim/85 px-3 py-1 font-mono text-sm text-white">
            {fmt(gestureScrubMs)} / {durationMs > 0 ? fmt(durationMs) : "--:--"}
          </div>
        )}

        {/*
          控制条。播放中淡出，暂停或鼠标移入时出现。
          `pointer-events-none` 在隐藏时必须加上 —— 否则一条不可见但可点的
          横条会挡住视频下方的画面。
        */}
        <div
          className={
            "absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2 pt-6 transition-opacity " +
            (controlsVisible ? "opacity-100" : "pointer-events-none opacity-0")
          }
        >
          <input
            type="range"
            min={0}
            max={Math.max(1, Math.round(durationMs))}
            value={Math.round(scrubMs ?? mediaTimeMs)}
            onChange={(event) => setScrubMs(Number(event.target.value))}
            /*
             * 松手才真的 seek：拖动过程中连续 seek 会让 hls.js 反复重新缓冲，
             * 而且每次 seek 都会触发服务端的弹幕窗口重建（网关被打爆）。
             */
            onPointerUp={() => {
              if (scrubMs !== null) seekTo(scrubMs);
              setScrubMs(null);
            }}
            onKeyUp={() => {
              if (scrubMs !== null) seekTo(scrubMs);
              setScrubMs(null);
            }}
            aria-label="播放进度"
            className="player-range w-full"
          />
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-white">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={paused ? "播放" : "暂停"}
              title={paused ? "播放（空格）" : "暂停（空格）"}
              className="player-btn"
            >
              {paused ? "▶" : "❚❚"}
            </button>
            <span className="font-mono">
              {fmt(scrubMs ?? mediaTimeMs)} / {durationMs > 0 ? fmt(durationMs) : "--:--"}
            </span>

            <button
              type="button"
              onClick={() => nudgeSpeed(-1)}
              aria-label="减速"
              title="减速（[）"
              className="player-btn"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => applySpeed(DEFAULT_SPEED)}
              aria-label={`播放速度 ${formatSpeed(speed)}，点击恢复正常速度`}
              title="恢复正常速度（0）"
              className="player-btn font-mono"
            >
              {formatSpeed(speed)}
            </button>
            <button
              type="button"
              onClick={() => nudgeSpeed(1)}
              aria-label="加速"
              title="加速（]）"
              className="player-btn"
            >
              ＋
            </button>

            <button
              type="button"
              onClick={toggleMute}
              aria-label={muted ? "取消静音" : "静音"}
              title={muted ? "取消静音（M）" : "静音（M）"}
              className="player-btn"
            >
              {muted ? "🔇" : "🔊"}
            </button>

            <label className="ml-auto flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={autoNext}
                onChange={(event) => {
                  setAutoNext(event.target.checked);
                  autoNextRef.current = event.target.checked;
                  writePlayerPrefs({ autoNext: event.target.checked, speed: speedRef.current });
                  // 关掉时立刻收起倒计时 —— 否则还会继续数到 0 并换集
                  if (!event.target.checked) setCountdown(null);
                }}
                className="size-3.5 accent-sky-500"
              />
              <span>自动连播</span>
            </label>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "退出全屏" : "全屏"}
              title={fullscreen ? "退出全屏（F）" : "全屏（F）"}
              className="player-btn"
            >
              {fullscreen ? "⤢" : "⛶"}
            </button>
          </div>
        </div>

        {/*
          自动连播倒计时。给 5 秒而不是立刻切 —— 立刻切会让人以为播放器坏了，
          而且没有机会取消（比如想再看一遍片尾）。
        */}
        {countdown !== null && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-scrim/80 text-center text-white">
            <p className="text-sm">即将播放下一集</p>
            <p className="font-mono text-3xl">{countdown}</p>
            <div className="flex gap-3">
              <button type="button" onClick={advanceToNext} className="btn btn-sm bg-primary text-white">
                立即播放
              </button>
              <button
                type="button"
                onClick={() => setCountdown(null)}
                className="btn btn-ghost btn-sm text-white"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {episodeId === null && (
        <p className="alert alert-warn">
          这一集在 Bangumi 里找不到对应集数，已禁用弹幕 ——
          避免把弹幕挂到错误的集上。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-on-surface-variant/70">
        <span className="font-mono">
          {fmt(mediaTimeMs)} / {durationMs > 0 ? fmt(durationMs) : "--:--"}
        </span>
        <span>已加载弹幕 {danmakus.length} 条</span>
        <span className="text-on-surface-variant/70">
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
          className="rounded bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary disabled:opacity-40"
        >
          发送
        </button>
      </div>

      {/*
        弹幕显示设置。折叠起来 —— 它是「调一次就不动」的东西，
        铺开会把发送框挤到屏幕外。
      */}
      <details className="group">
        <summary className="cursor-pointer text-sm text-on-surface-variant marker:text-outline">
          <span className="group-open:hidden">弹幕显示设置</span>
          <span className="hidden group-open:inline">收起设置</span>
        </summary>
        <div className="mt-2">
          <DanmakuSettings onChange={setActiveStyle} />
        </div>
      </details>

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}
    </section>
  );
}
