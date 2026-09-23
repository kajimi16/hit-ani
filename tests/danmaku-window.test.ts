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
  MAX_PLAY_TIME_MS,
  MIN_REFILL_INTERVAL_MS,
  REPOPULATE_LOOKAHEAD_MS,
  REPOPULATE_LOOKBACK_MS,
  canRefillNow,
  clampPlayTime,
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

/* ---------------------------------------------------------------- *
 * 播放位置钳制 —— 客户端上报的值不可信
 * ---------------------------------------------------------------- */

test("clampPlayTime 把非法值归零", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, -1000, 0]) {
    assert.equal(clampPlayTime(bad), 0, `${bad} 应归零`);
  }
});

test("clampPlayTime 保留正常值", () => {
  assert.equal(clampPlayTime(1000), 1000);
  assert.equal(clampPlayTime(600_000), 600_000);
});

test("clampPlayTime 钳住超大值（客户端可能被篡改）", () => {
  // 越界值会让窗口落到不可能的区间，既查不到数据也让「已请求过」记录失真
  assert.equal(clampPlayTime(MAX_PLAY_TIME_MS + 1), MAX_PLAY_TIME_MS);
  assert.equal(clampPlayTime(Number.MAX_SAFE_INTEGER), MAX_PLAY_TIME_MS);
});

test("repopulateWindow 对畸形输入不产生畸形窗口", () => {
  for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, 1e15]) {
    const w = repopulateWindow(bad);
    assert.ok(Number.isFinite(w.fromMs), `${bad}: fromMs 应有限`);
    assert.ok(Number.isFinite(w.toMs), `${bad}: toMs 应有限`);
    assert.ok(w.fromMs >= 0);
    assert.ok(w.toMs >= w.fromMs);
    assert.ok(w.toMs <= MAX_PLAY_TIME_MS + REPOPULATE_LOOKAHEAD_MS);
  }
});

/* ---------------------------------------------------------------- *
 * 网关节流 —— 拖动进度条不应打爆服务端
 * ---------------------------------------------------------------- */

test("canRefillNow 在节流窗口内拒绝", () => {
  const t = 1_000_000;
  assert.equal(canRefillNow(t, t + 0), false, "同一时刻应拒绝");
  assert.equal(canRefillNow(t, t + 100), false, "100ms 后仍应拒绝");
  assert.equal(canRefillNow(t, t + MIN_REFILL_INTERVAL_MS - 1), false, "差 1ms 应拒绝");
});

test("canRefillNow 在节流窗口外放行", () => {
  const t = 1_000_000;
  assert.equal(canRefillNow(t, t + MIN_REFILL_INTERVAL_MS), true, "恰好到期应放行");
  assert.equal(canRefillNow(t, t + 5000), true);
});

test("canRefillNow 首次调用（lastRefillAt=0）放行", () => {
  assert.equal(canRefillNow(0, Date.now()), true);
});

test("节流间隔明显大于客户端的防抖间隔（服务端只作防御）", () => {
  // 客户端防抖 250ms 是主要防线；服务端设 300ms 兜底。
  // 若服务端间隔小于客户端防抖，正常拖动会被服务端误拒。
  const CLIENT_SEEK_DEBOUNCE_MS = 250;
  assert.ok(
    MIN_REFILL_INTERVAL_MS >= CLIENT_SEEK_DEBOUNCE_MS,
    `服务端节流(${MIN_REFILL_INTERVAL_MS}) 应 ≥ 客户端防抖(${CLIENT_SEEK_DEBOUNCE_MS})，否则会误拒正常上报`,
  );
});

test("模拟拖动：连发 seek 只按时间窗放行", () => {
  // 用户拖动进度条时 seeked 连发；若无节流，全部都会打到数据库。
  // 放行次数 = 拖动时长 / 节流间隔（向上取整），与事件次数无关 —— 这正是要点。
  const dragDurationMs = 400;
  const intervalMs = 10;
  const events = dragDurationMs / intervalMs;
  const expectedAllowed = Math.floor(dragDurationMs / MIN_REFILL_INTERVAL_MS) + 1;

  let lastRefillAt = 0;
  let allowed = 0;
  let now = 100_000;
  for (let i = 0; i < events; i += 1) {
    now += intervalMs;
    if (canRefillNow(lastRefillAt, now)) {
      allowed += 1;
      lastRefillAt = now;
    }
  }

  assert.equal(allowed, expectedAllowed, `应为 ${expectedAllowed} 次（按时间窗），实际 ${allowed}`);
  assert.ok(allowed < events / 10, `${events} 次事件应被压到个位数，实际 ${allowed}`);
});

test("模拟停顿式拖动：每次停顿后都放行", () => {
  // 用户拖一下停一下：每次停顿都该生效，否则会丢位置
  let lastRefillAt = 0;
  let allowed = 0;
  let now = 100_000;
  for (let i = 0; i < 5; i += 1) {
    now += 500; // 超过节流间隔
    if (canRefillNow(lastRefillAt, now)) {
      allowed += 1;
      lastRefillAt = now;
    }
  }
  assert.equal(allowed, 5, "每次停顿都该放行");
});
