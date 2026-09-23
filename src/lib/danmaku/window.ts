/**
 * 弹幕网关的窗口策略。
 *
 * ## 为什么不能「进房就全量下发」
 *
 * 实测一集 2000 条约 **381 KB**。每个新连接都推这么多，且客户端要在这份
 * 越来越长的列表上每帧过滤 —— 多人同时观看时是明显的带宽与内存浪费。
 *
 * ## 也不能钉死在 [0, 3 分钟]
 *
 * 早先的实现是 `fromMs: 0, toMs: 3 * 60 * 1000`，配合客户端 20 秒的渲染窗口 ——
 * 说明**原本的意图是「围绕播放位置取一段」**，只是原点被写死成 0。
 * 后果：播到第 3 分钟后就没有弹幕；跳转到后半段更是完全空白。
 *
 * ## 现在的做法：窗口锚定客户端上报的播放位置
 *
 * - 进房时客户端用 `?playTimeMs=` 上报当前位置
 * - seek 时客户端发 `{ type: "seek", playTimeMs }` 重新锚定
 * - 窗口 = `[playhead - LOOKBACK, playhead + LOOKAHEAD]`
 *
 * `LOOKBACK` 覆盖客户端 20 秒的渲染窗口加余量；`LOOKAHEAD` 给出足够缓冲，
 * 之后由客户端的按需补充（refill）继续向前。
 */

/** 窗口向前取多少。客户端只渲染最近 20 秒的弹幕，这里留足余量。 */
export const REPOPULATE_LOOKBACK_MS = 30_000;

/** 窗口向后取多少。3 分钟缓冲，之后客户端自行 refill。 */
export const REPOPULATE_LOOKAHEAD_MS = 3 * 60 * 1000;

/**
 * 播放位置的上界。
 *
 * 服务端不知道视频时长，而客户端上报的位置**不可信** ——
 * 越界值会让窗口落到不可能的区间（例如 10 小时处），既查不到数据，
 * 也让「已请求过的窗口」记录失真。24 小时足以覆盖任何单集。
 */
export const MAX_PLAY_TIME_MS = 24 * 60 * 60 * 1000;

/** 把上报的播放位置钳到合法区间。非法值（NaN/负数/越界）一律归零或钳到上界。 */
export function clampPlayTime(playTimeMs: number): number {
  if (!Number.isFinite(playTimeMs) || playTimeMs <= 0) return 0;
  return Math.min(playTimeMs, MAX_PLAY_TIME_MS);
}

/**
 * 计算回填窗口。
 *
 * 起点不为负 —— 播放位置在开头时窗口会自然截到 0。
 * 位置先经 `clampPlayTime`，因此 **NaN/负数/极大值都不会产生畸形窗口**
 * （那类输入来自客户端，不可信）。
 */
export function repopulateWindow(playTimeMs: number): { fromMs: number; toMs: number } {
  const anchor = clampPlayTime(playTimeMs);
  return {
    fromMs: Math.max(0, anchor - REPOPULATE_LOOKBACK_MS),
    toMs: anchor + REPOPULATE_LOOKAHEAD_MS,
  };
}

/**
 * 同一连接两次回填的最小间隔。
 *
 * 客户端已对 seek 做防抖（停顿后才发），这里是**服务端的防御**：
 * 客户端可能被篡改，程序化 seek（例如 `currentTime` 循环赋值）也会绕过防抖。
 * 没有它，拖动进度条能让网关被单条连接打爆。
 */
export const MIN_REFILL_INTERVAL_MS = 300;

/**
 * 判定现在是否可以回填。
 *
 * 节流窗口内的请求**被丢弃**（不排队）—— 这是有意的取舍：
 * - 客户端已防抖，正常拖动不会连续发；
 * - 真被丢弃的那次，紧接的后续 seek 会带来更新的位置，
 *   而「最后一个位置」才是用户实际停在的地方；
 * - 排队反而会把过期的中间位置全部执行一遍，正是要避免的浪费。
 */
export function canRefillNow(
  lastRefillAt: number,
  now: number,
  minIntervalMs = MIN_REFILL_INTERVAL_MS,
): boolean {
  return now - lastRefillAt >= minIntervalMs;
}
