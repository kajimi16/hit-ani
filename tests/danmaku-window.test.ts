/**
 * 弹幕回填窗口测试。
 *
 * ## 为什么需要
 *
 * 这里是「库里有几千条弹幕、播放时只看到几条」的现场。
 * 先后出过两个 bug：
 *
 * 1. 窗口被钉死在 `[0, 3 分钟]` —— 播过第 3 分钟就再也没有弹幕
 * 2. 修掉 (1) 后改成「进房全量下发」—— 实测 381 KB/连接，
 *    而且没解决 seek（跳到后段仍无弹幕）
 *
 * 正确的意图（从客户端 20 秒渲染窗口可以推断）是「窗口围绕播放位置」。
 * 这组测试把这条钉住。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REPOPULATE_LOOKAHEAD_MS,
  REPOPULATE_LOOKBACK_MS,
  repopulateWindow,
} from "@/lib/danmaku/window";

test("窗口锚定播放位置，不是固定在 0", () => {
  // 这是核心：窗口必须跟着播放位置走
  const at10min = repopulateWindow(10 * 60 * 1000);
  assert.ok(at10min.fromMs > 0, "播放到 10 分钟时窗口起点不该是 0");

  const at20min = repopulateWindow(20 * 60 * 1000);
  assert.ok(at20min.fromMs > at10min.fromMs, "播放越靠后，窗口起点越靠后");
});

test("窗口向前后各取固定量", () => {
  const position = 600_000;
  const w = repopulateWindow(position);
  assert.equal(w.fromMs, position - REPOPULATE_LOOKBACK_MS);
  assert.equal(w.toMs, position + REPOPULATE_LOOKAHEAD_MS);
});

test("回看量覆盖客户端的 20 秒渲染窗口", () => {
  // 客户端只渲染最近 20 秒的弹幕；回看量若小于它，屏幕上会缺弹幕
  const CLIENT_RENDER_WINDOW_MS = 20_000;
  assert.ok(
    REPOPULATE_LOOKBACK_MS >= CLIENT_RENDER_WINDOW_MS,
    `回看量 ${REPOPULATE_LOOKBACK_MS} 必须 ≥ 客户端渲染窗口 ${CLIENT_RENDER_WINDOW_MS}`,
  );
});

test("播放位置在开头时窗口截到 0，不产生负数", () => {
  for (const position of [0, 1000, REPOPULATE_LOOKBACK_MS - 1]) {
    const w = repopulateWindow(position);
    assert.equal(w.fromMs, 0, `位置 ${position} 时窗口起点应为 0`);
    assert.ok(w.toMs > 0);
  }
});

test("非法位置按 0 处理（不产生 NaN 窗口）", () => {
  for (const bad of [Number.NaN, -1, -1000]) {
    const w = repopulateWindow(bad);
    assert.ok(Number.isFinite(w.fromMs) && Number.isFinite(w.toMs));
    assert.equal(w.fromMs, 0);
    assert.ok(w.toMs > 0);
  }
});

test("窗口时长恒定（便于估算载荷）", () => {
  const span = REPOPULATE_LOOKBACK_MS + REPOPULATE_LOOKAHEAD_MS;
  for (const position of [0, 1000, 600_000, 3_600_000]) {
    const w = repopulateWindow(position);
    // 位置为 0 时起点被截到 0，跨度会小于理论值 —— 这是对的
    if (position >= REPOPULATE_LOOKBACK_MS) {
      assert.equal(w.toMs - w.fromMs, span);
    } else {
      assert.ok(w.toMs - w.fromMs <= span);
    }
  }
});

test("回看量远小于回看后量 —— 载荷由后者主导", () => {
  // 若回看量过大，窗口会包含大量已播过的弹幕，白白增加载荷
  assert.ok(
    REPOPULATE_LOOKBACK_MS < REPOPULATE_LOOKAHEAD_MS,
    "回看量应明显小于前瞻量",
  );
});
