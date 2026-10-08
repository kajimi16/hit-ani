/**
 * 弹幕显示样式 —— 用户可调。
 *
 * ## 为什么需要
 *
 * 此前字号、透明度、显示区域、速度**全部硬编码**在 `video-player.tsx` 里
 * （`TRACK_COUNT = 8`、`TRACK_HEIGHT = 26`、`SPEED_PX_PER_MS = 0.18`），
 * 手机上字号明显偏小、弹幕又密，却没有办法调。
 *
 * ## 与主题偏好同一套做法，理由也相同
 *
 * 存 `localStorage`：这是**设备级**偏好（手机要小字密排，台式机要大字号），
 * 而这些设备共用同一个账号。存本地也避免首屏等待服务端。
 *
 * ## 取值范围都做成常量而非散落的字面量
 *
 * 滑块要用它们设 `min`/`max`，渲染要用它们换算 —— 两处各写一遍必然漂移，
 * 而漂移的症状是「滑块拖到头了弹幕还在变」。
 */

import { DanmakuLocation } from "@/lib/danmaku/types";

export const DANMAKU_STORAGE_KEY = "hit-ani-danmaku";

export interface DanmakuStyle {
  /** 开关。关掉即整个 canvas 不绘制（不是把透明度调到 0 —— 那还在占用绘制）。 */
  enabled: boolean;
  /** 字号（px）。**基准值**，实际渲染按画布高度缩放。 */
  fontSize: number;
  /** 不透明度 0–1。 */
  opacity: number;
  /**
   * 显示区域比例 0–1 —— 弹幕最多占用画面高度的多少。
   * 0.5 表示只在上半屏滚动，方便看字幕。
   */
  area: number;
  /** 速度倍率。1 = 原速；越大弹幕飞得越快、屏上停留越短。 */
  speed: number;
  /** 顶部固定弹幕 */
  showTop: boolean;
  /** 底部固定弹幕 */
  showBottom: boolean;
  /** 滚动弹幕 */
  showScroll: boolean;
}

/** 滑块与校验共用同一份边界。 */
export const DANMAKU_LIMITS = {
  fontSize: { min: 12, max: 32, step: 1 },
  opacity: { min: 0.2, max: 1, step: 0.05 },
  area: { min: 0.25, max: 1, step: 0.05 },
  speed: { min: 0.5, max: 2, step: 0.1 },
} as const;

/**
 * 默认值 —— 与改动前的硬编码保持等价，这样老用户升级后观感不变。
 *
 * `fontSize: 16` 对应原来的 `CHAR_WIDTH = 16`；`speed: 1` 对应
 * `SPEED_PX_PER_MS = 0.18`；`area: 1` 表示不限制区域。
 */
export const DEFAULT_DANMAKU_STYLE: DanmakuStyle = {
  enabled: true,
  fontSize: 16,
  opacity: 1,
  area: 1,
  speed: 1,
  showTop: true,
  showBottom: true,
  showScroll: true,
};

/** 把任意值夹到区间内；非有限数退回 `fallback`。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 归一化一份（可能来自 localStorage 的）样式对象。
 *
 * **必须逐字段校验**：localStorage 是可被用户改写的，而一个越界的
 * `fontSize: 1e9` 会让 canvas 直接卡死。逐字段夹取比「整体信任」稳妥得多。
 */
export function normalizeDanmakuStyle(raw: unknown): DanmakuStyle {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_DANMAKU_STYLE };
  const value = raw as Partial<Record<keyof DanmakuStyle, unknown>>;

  return {
    // 布尔字段用严格等值：`"false"` 字符串不该被当成 true
    enabled: value.enabled !== false,
    fontSize: clampNumber(value.fontSize, DANMAKU_LIMITS.fontSize.min, DANMAKU_LIMITS.fontSize.max, DEFAULT_DANMAKU_STYLE.fontSize),
    opacity: clampNumber(value.opacity, DANMAKU_LIMITS.opacity.min, DANMAKU_LIMITS.opacity.max, DEFAULT_DANMAKU_STYLE.opacity),
    area: clampNumber(value.area, DANMAKU_LIMITS.area.min, DANMAKU_LIMITS.area.max, DEFAULT_DANMAKU_STYLE.area),
    speed: clampNumber(value.speed, DANMAKU_LIMITS.speed.min, DANMAKU_LIMITS.speed.max, DEFAULT_DANMAKU_STYLE.speed),
    showTop: value.showTop !== false,
    showBottom: value.showBottom !== false,
    showScroll: value.showScroll !== false,
  };
}

/** 读取样式。读不到或隐私模式抛异常时用默认值。 */
export function readDanmakuStyle(): DanmakuStyle {
  try {
    const stored = localStorage.getItem(DANMAKU_STORAGE_KEY);
    return stored ? normalizeDanmakuStyle(JSON.parse(stored)) : { ...DEFAULT_DANMAKU_STYLE };
  } catch {
    return { ...DEFAULT_DANMAKU_STYLE };
  }
}

/** 写入样式。存不下不该让这次调整失败。 */
export function writeDanmakuStyle(style: DanmakuStyle): void {
  try {
    localStorage.setItem(DANMAKU_STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* 只影响下次打开 */
  }
}

/**
 * 按样式决定某条弹幕是否该画。
 *
 * 抽成纯函数：三条开关的与逻辑写反（例如 `||`）不会有任何报错，
 * 只表现为「关了顶弹幕但顶部还在显示」。
 *
 * ## 必须用本仓库的枚举，不能写字面量
 *
 * 第一版这里写的是 `5`=顶部 / `4`=底部 —— 那是 **BGM API 的取值**，
 * 而本仓库的 `DanmakuLocation` 是 `Normal:0, Top:1, Bottom:2`
 * （见 `types.ts`，`video-player.tsx` 用的也是这一套）。
 *
 * 后果很隐蔽：`1` 和 `2` 都落到 `return style.showScroll`，于是
 * 「顶部」「底部」两个开关**永远不生效**，而关掉「滚动」会把**所有**
 * 弹幕一起藏掉。没有任何报错。
 *
 * 所以这里导入枚举而不是写字面量 —— 正是本文件注释里反复警告的那类
 * 「静默失效」错误。
 */
export function shouldRenderDanmaku(style: DanmakuStyle, location: number): boolean {
  if (!style.enabled) return false;
  if (location === DanmakuLocation.Top) return style.showTop;
  if (location === DanmakuLocation.Bottom) return style.showBottom;
  return style.showScroll;
}

/* ---------------------------------------------------------------- *
 * 布局换算
 * ---------------------------------------------------------------- */

/** 基准轨道数。改动前是 `const TRACK_COUNT = 8`。 */
export const BASE_TRACK_COUNT = 8;
/**
 * 行高 / 字号。改动前 `TRACK_HEIGHT = 26`、字号 16 → 26/16。
 *
 * 不写死 26：字号调大后行高必须跟着长，否则文字会上下压在一起。
 */
export const TRACK_HEIGHT_RATIO = 26 / 16;
/**
 * 字宽 / 字号。改动前 `CHAR_WIDTH = 16`、字号 16 → 1.0。
 *
 * 取 1.0 是因为弹幕以中文为主（全角，字宽≈字号）。拉丁文本会被高估，
 * 而**高估比低估安全**：碰撞检测偏保守，最多让轨道分配得松一点，
 * 不会让两条弹幕叠在一起。
 */
export const CHAR_WIDTH_RATIO = 1;

export interface DanmakuLayout {
  /** 实际使用的轨道数 —— 由「显示区域」决定。 */
  trackCount: number;
  trackHeight: number;
  /** canvas 的 CSS 高度。区域小则画布也矮，不会留出一块空白挡着视频。 */
  canvasHeight: number;
  charWidth: number;
  /** 实际像素/毫秒 —— 由「速度倍率」缩放。 */
  speedPxPerMs: number;
}

/**
 * 由样式算出绘制参数。
 *
 * **渲染画布尺寸与逐帧绘制都调它**：两处各算一遍迟早漂移，而漂移的症状是
 * 「画布是 208px 高但只画了 4 条轨」这种留出一块空白的错位。
 */
export function danmakuLayout(style: DanmakuStyle): DanmakuLayout {
  const trackHeight = Math.round(style.fontSize * TRACK_HEIGHT_RATIO);
  // 至少一条轨 —— 区域调到最小时仍要能显示弹幕，而不是什么都不画
  const trackCount = Math.max(1, Math.round(BASE_TRACK_COUNT * style.area));
  return {
    trackCount,
    trackHeight,
    canvasHeight: trackCount * trackHeight,
    charWidth: style.fontSize * CHAR_WIDTH_RATIO,
    speedPxPerMs: BASE_SPEED_PX_PER_MS * style.speed,
  };
}

/** 基准速度（px/ms）。改动前是 `const SPEED_PX_PER_MS = 0.18`。 */
export const BASE_SPEED_PX_PER_MS = 0.18;
