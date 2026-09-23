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
 * 计算回填窗口。
 *
 * 起点不为负 —— 播放位置在开头时窗口会自然截到 0。
 */
export function repopulateWindow(playTimeMs: number): { fromMs: number; toMs: number } {
  const anchor = Number.isFinite(playTimeMs) && playTimeMs > 0 ? playTimeMs : 0;
  return {
    fromMs: Math.max(0, anchor - REPOPULATE_LOOKBACK_MS),
    toMs: anchor + REPOPULATE_LOOKAHEAD_MS,
  };
}
