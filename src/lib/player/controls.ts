/**
 * 播放器自绘控件的**纯逻辑**。
 *
 * 抽出来的理由与 `danmaku/style.ts` 相同：这些换算写在组件里就只能靠肉眼
 * 保证，而它们每一个出错都**不会报错**，只是「行为有点怪」——
 * 正是本项目反复踩的那一类。
 *
 * 组件只负责 DOM 事件与绘制，判断一律走这里。
 */

/**
 * `setTimeout` 的句柄类型。
 *
 * Node 与浏览器的 `setTimeout` 返回不同类型（`Timeout` / `number`），
 * 这里取一次名，让消费方不必各自写 `ReturnType<typeof setTimeout>`
 * （那种写法把实现细节写进了类型位置，且看的人要先查 `setTimeout` 的定义）。
 */
export type TimerHandle = ReturnType<typeof setTimeout>;

/* ------------------------------------------------------------------ *
 * 倍速
 * ------------------------------------------------------------------ */

/**
 * 倍速阶梯。
 *
 * 用**离散档位**而不是「每次 ±0.1」：连续微调会产生 1.2999999 这种值，
 * 显示出来难看，而且用户想回到 1.0 得按好几次。阶梯让「按两下到 1.5」
 * 成为确定的行为。
 */
export const SPEED_LADDER = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;

export const DEFAULT_SPEED = 1;

/**
 * 在阶梯上移动一档。
 *
 * `delta` 为正则加速、为负则减速。已经到两端时**停在端点**（不回绕）——
 * 回绕会让「一直按加速」从 3× 突然跳回 0.5×，而用户的意图显然是「最快」。
 *
 * 传入不在阶梯上的值时（例如从别处传来的 1.1），先归到最近的档，
 * 再按方向移动，避免出现「按了没反应」。
 */
export function stepSpeed(current: number, delta: number): number {
  if (delta === 0) return current;

  const index = nearestSpeedIndex(current);
  const next = index + (delta > 0 ? 1 : -1);
  const clamped = Math.min(SPEED_LADDER.length - 1, Math.max(0, next));
  return SPEED_LADDER[clamped];
}

/** 最接近的档位下标。非有限值一律回到默认档。 */
export function nearestSpeedIndex(speed: number): number {
  if (!Number.isFinite(speed)) return SPEED_LADDER.indexOf(DEFAULT_SPEED);
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < SPEED_LADDER.length; i += 1) {
    const distance = Math.abs(SPEED_LADDER[i] - speed);
    // 用 `<` 而不是 `<=`：并列时取较小档（更保守，不会莫名加速）
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** 显示用：`1×` / `1.5×`（不补零，`0.5` 保持一位小数）。 */
export function formatSpeed(speed: number): string {
  return `${Number.isInteger(speed) ? speed : speed.toFixed(2).replace(/0+$/, "")}×`;
}

/* ------------------------------------------------------------------ *
 * 快捷键
 * ------------------------------------------------------------------ */

/** 快捷键能触发的动作。组件据此执行，逻辑与执行分离。 */
export type ShortcutAction =
  | { kind: "toggle-play" }
  | { kind: "seek-by"; seconds: number }
  | { kind: "speed"; delta: number }
  | { kind: "speed-reset" }
  | { kind: "volume"; delta: number }
  | { kind: "toggle-mute" }
  | { kind: "toggle-fullscreen" };

/** 方向键每次跳转的秒数。 */
export const SEEK_STEP_SECONDS = 5;
/** 音量键每次调整的幅度（0-1）。 */
export const VOLUME_STEP = 0.05;

/**
 * 该事件目标是否**自己拥有键盘** —— 拥有时播放器一律不拦。
 *
 * 覆盖两类，缺一不可：
 *
 * 1. **正在输入**（`input` / `textarea` / `select` / `contenteditable`）。
 *    弹幕输入框就在同一个组件里 —— 不过滤的话用户打弹幕时敲 `[` 会改倍速、
 *    敲空格会暂停、敲 `f` 会全屏，而**没有任何报错**。
 * 2. **已聚焦的可操作控件**（`button` / `a` / `summary`）。用户刚刚点了
 *    「静音」按钮，此时按空格应当**再点一次那个按钮**，而不是被我们抢去
 *    切换播放。空格与回车对按钮来说就是「激活」，抢过来是错的。
 *
 * `contenteditable` 必须查 `isContentEditable` —— 它不在 `tagName` 上，
 * 只查 tagName 会漏掉整个富文本场景。
 */
export function ownsKeyboard(target: {
  tagName?: string;
  isContentEditable?: boolean;
} | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "BUTTON" ||
    tag === "A" ||
    tag === "SUMMARY"
  );
}

/**
 * 把按键解析成动作。不认识的键返回 `null`（不拦截）。
 *
 * `targetOwnsKeys` 由 `ownsKeyboard()` 得出 —— 见那里的说明，
 * 它同时覆盖「正在输入」与「已聚焦的控件」两类。
 *
 * `key` 用 `KeyboardEvent.key`（不是 `code`）—— 这样在非英文键盘布局下
 * 按下的仍是**印在键上的那个字符**对应的行为。中文输入法不会影响它，
 * 因为输入法组合期间的按键会被 `ownsKeyboard` 拦掉。
 */
export function resolveShortcut(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  targetOwnsKeys: boolean;
}): ShortcutAction | null {
  // 带修饰键的组合留给浏览器（Ctrl+F 查找、Cmd+R 刷新…），一律不拦
  if (input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.targetOwnsKeys) return null;

  switch (input.key) {
    case " ":
    case "k":
    case "K":
      return { kind: "toggle-play" };
    case "ArrowLeft":
      return { kind: "seek-by", seconds: -SEEK_STEP_SECONDS };
    case "ArrowRight":
      return { kind: "seek-by", seconds: SEEK_STEP_SECONDS };
    case "ArrowUp":
      return { kind: "volume", delta: VOLUME_STEP };
    case "ArrowDown":
      return { kind: "volume", delta: -VOLUME_STEP };
    case "[":
      return { kind: "speed", delta: -1 };
    case "]":
      return { kind: "speed", delta: 1 };
    case "0":
      return { kind: "speed-reset" };
    case "m":
    case "M":
      return { kind: "toggle-mute" };
    case "f":
    case "F":
      return { kind: "toggle-fullscreen" };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * 拖动定位
 * ------------------------------------------------------------------ */

/**
 * 横向拖动的位移换算成新的播放位置。
 *
 * `ratio` 是拖动距离相对视频宽度的比例（拖动整屏 = 1）。用**相对宽度**而不是
 * 固定秒数，手机上（宽度小）不会因为拖一点点就跳几十秒。
 *
 * `direction` 由调用方给：**横向从左到右 = 快进**；但有些播放器用
 * 「拖动距离与时长成正比」的绝对定位（拖到屏幕 60% = 片子的 60%）。
 * 这里选**相对**方式 —— 与 B 站/Animeko 一致，且不会因为片子长就失控。
 */
export function seekTargetFromDrag(input: {
  startMs: number;
  dragRatio: number;
  durationMs: number;
  /** 拖动 1 倍视频宽度对应多少秒。 */
  fullWidthSeconds?: number;
}): number {
  const { startMs, dragRatio, durationMs } = input;
  const fullWidthSeconds = input.fullWidthSeconds ?? 90;
  if (!Number.isFinite(dragRatio) || dragRatio === 0) return clampTime(startMs, durationMs);

  const target = startMs + dragRatio * fullWidthSeconds * 1000;
  return clampTime(target, durationMs);
}

/** 把时间钳制到 `[0, durationMs]`。时长为未知（0/NaN）时只保证非负。 */
export function clampTime(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  const nonNegative = Math.max(0, ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return nonNegative;
  return Math.min(nonNegative, durationMs);
}

/* ------------------------------------------------------------------ *
 * 自动连播
 * ------------------------------------------------------------------ */

/**
 * 是否该自动切下一集。
 *
 * 三个条件缺一不可，每一个都对应一种「不该切」的真实情况：
 * - `enabled` 为假 —— 用户关了自动连播；
 * - `hasNext` 为假 —— 已经是最后一集（否则会去请求不存在的下一集）；
 * - `ended` 为假 —— 用户只是切走了/暂停了，不该被拉回来。
 */
export function shouldAutoAdvance(input: {
  enabled: boolean;
  hasNext: boolean;
  ended: boolean;
}): boolean {
  return input.enabled && input.hasNext && input.ended;
}

/** 自动连播的倒计时秒数。太短来不及取消，太长会让人觉得卡住。 */
export const NEXT_COUNTDOWN_SECONDS = 5;

/**
 * 倒计时显示的剩余秒数。
 *
 * `elapsedMs` 超过总时长时返回 0（而不是负数）—— 负数的 `-1s` 会显示出来。
 */
export function countdownRemaining(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  const remaining = NEXT_COUNTDOWN_SECONDS - Math.floor(elapsedMs / 1000);
  return Math.max(0, remaining);
}

/* ------------------------------------------------------------------ *
 * 偏好持久化
 * ------------------------------------------------------------------ */

/**
 * 播放器偏好。
 *
 * ## 为什么必须持久化而不是放在组件里
 *
 * `SourcePlayer` 给播放器挂了 `key={playing.url}` —— 换集时组件**整体重挂**，
 * 任何组件内部状态都会被重置。于是会出现：用户在第一集关掉「自动连播」，
 * 手动点开第二集，开关又自己打开了，然后看完一集被自动切走。
 * 这是「设置看起来生效了、其实每次都被重置」这一类，没有报错。
 */
export interface PlayerPrefs {
  /** 自动连播。 */
  autoNext: boolean;
  /** 播放倍速。 */
  speed: number;
}

/** 与改动前的行为等价：不自动连播以外的一切都照旧（1×）。 */
export const DEFAULT_PLAYER_PREFS: PlayerPrefs = { autoNext: true, speed: DEFAULT_SPEED };

const PREFS_STORAGE_KEY = "hit-ani:player-prefs";

/**
 * 归一化。
 *
 * localStorage **可以被用户改写**，因此逐字段校验：
 * - `speed` 只接受阶梯上的值（不在阶梯上就找最近的档）——
 *   否则 `1e9` 这样的值会让 `playbackRate` 直接抛异常；
 * - 布尔只认真正的 `true` / `false`，字符串 `"false"` 不算。
 */
export function normalizePlayerPrefs(raw: unknown): PlayerPrefs {
  if (raw === null || typeof raw !== "object") return DEFAULT_PLAYER_PREFS;
  const value = raw as Record<string, unknown>;

  const speed =
    typeof value.speed === "number" && Number.isFinite(value.speed)
      ? SPEED_LADDER[nearestSpeedIndex(value.speed)]
      : DEFAULT_PLAYER_PREFS.speed;

  return {
    autoNext: typeof value.autoNext === "boolean" ? value.autoNext : DEFAULT_PLAYER_PREFS.autoNext,
    speed,
  };
}

export function readPlayerPrefs(): PlayerPrefs {
  try {
    const stored = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!stored) return DEFAULT_PLAYER_PREFS;
    return normalizePlayerPrefs(JSON.parse(stored));
  } catch {
    // 隐私模式下 localStorage 会抛异常、手工改坏的值会解析失败 —— 都用默认值
    return DEFAULT_PLAYER_PREFS;
  }
}

export function writePlayerPrefs(prefs: PlayerPrefs): void {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // 写不进去不影响本次播放
  }
}

/* ------------------------------------------------------------------ *
 * 续播
 * ------------------------------------------------------------------ */

/**
 * 续播的起始位置。
 *
 * ## 为什么需要「集号」而不只是位置
 *
 * 位置在库里是**条目级**的（一部番同时只在一个位置续看），但只凭位置
 * 无法判断它属于哪一集。实测的后果：
 *
 * - 看完第 1 集自动切到第 2 集 → 第 2 集在**开头**就跳到第 1 集的片尾位置，
 *   于是立刻又触发「播完」，一集接一集地空转；
 * - 手动点开第 5 集 → 从第 1 集的位置开始播。
 *
 * 因此位置必须连带记下「属于哪一集」（`Collection.playbackEpisodeId`），
 * 对不上就**从 0 开始**。
 *
 * ## 老数据为什么也返回 0
 *
 * 加这一列之前写入的 `playbackPositionMs` 没有集号。那种情况下**宁可从头
 * 播**也不猜 —— 猜错就是从片尾开始（用户看到「一打开就结束了」）。
 *
 * 另外 `SourcePlayer` 的 `key={playing.url}` 会让换集时播放器**整体重新挂载**，
 * 而 `resumePositionMs` 是服务端渲染的属性、一次会话内不变，所以判定
 * 必须在每次挂载时按当前集号重新做，不能缓存在调用方。
 */
export function resumeStartMs(input: {
  /** 当前这一集的 BGM episodeId；这一集在 BGM 里找不到对应时为 null。 */
  currentEpisodeId: number | null;
  /** 库里记着的位置属于哪一集；老数据为 null。 */
  recordedEpisodeId: number | null;
  /** 库里记着的位置（毫秒）。 */
  recordedPositionMs: number | null;
}): number {
  // 找不到对应集号时不续播 —— 这时连「是不是同一集」都无从判断
  if (input.currentEpisodeId === null || input.recordedEpisodeId === null) return 0;
  if (input.currentEpisodeId !== input.recordedEpisodeId) return 0;

  const position = input.recordedPositionMs;
  if (position === null || !Number.isFinite(position) || position <= 0) return 0;
  return position;
}
