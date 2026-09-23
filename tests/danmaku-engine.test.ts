/**
 * 弹幕纯逻辑单测：`node --test` + tsx 运行。
 * 运行：`npm test`
 *
 * 只测可观察行为与边界，不测实现细节。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateTracks,
  countCodePoints,
  filterBySchool,
  locationToName,
  normalizeQuery,
  sanitizeDanmakuText,
  sliceByTimeWindow,
  mergeById,
  shouldRefill,
  sortByPlayTime,
  summarize,
  validateSendInput,
} from "@/lib/danmaku/engine";
import { DANMAKU_LIMITS, DanmakuLocation, type DanmakuDto } from "@/lib/danmaku/types";
import { TokenBucketLimiter } from "@/lib/danmaku/rate-limit";

function dto(overrides: Partial<DanmakuDto> = {}): DanmakuDto {
  return {
    id: "d1",
    episodeId: 8,
    serviceId: "HitAni",
    senderId: "u1",
    senderName: "测试",
    schoolId: "hit",
    playTimeMs: 0,
    color: 0xffffff,
    text: "233",
    location: DanmakuLocation.Normal,
    ...overrides,
  };
}

test("sanitizeDanmakuText 折叠空白并剥离零宽字符", () => {
  assert.equal(sanitizeDanmakuText("  a\u200B b\n\nc "), "a b c");
  assert.equal(sanitizeDanmakuText("\uFEFF   "), "");
});

test("countCodePoints 按码点计数而非 UTF-16 长度", () => {
  assert.equal(countCodePoints("ab"), 2);
  // 单个 emoji 在 UTF-16 下长度为 2，但应算 1 个字符
  assert.equal(countCodePoints("🎉"), 1);
  assert.equal("🎉".length, 2);
});

test("validateSendInput 接受合法输入", () => {
  assert.deepEqual(
    validateSendInput({
      episodeId: 8,
      playTimeMs: 1000,
      text: "hello",
      color: 0xffffff,
      location: DanmakuLocation.Normal,
    }),
    [],
  );
});

test("validateSendInput 拒绝非法 episodeId / 负数时间 / 空文本", () => {
  assert.equal(
    validateSendInput({ episodeId: 0, playTimeMs: 0, text: "x" }).some(
      (e) => e.field === "episodeId",
    ),
    true,
  );
  assert.equal(
    validateSendInput({ episodeId: 8, playTimeMs: -1, text: "x" }).some(
      (e) => e.field === "playTimeMs",
    ),
    true,
  );
  assert.equal(
    validateSendInput({ episodeId: 8, playTimeMs: 0, text: "   " }).some(
      (e) => e.field === "text",
    ),
    true,
  );
});

test("validateSendInput 在字符数边界上恰好接受/拒绝", () => {
  const max = "a".repeat(DANMAKU_LIMITS.maxTextLength);
  assert.equal(validateSendInput({ episodeId: 8, playTimeMs: 0, text: max }).length, 0);

  const over = "a".repeat(DANMAKU_LIMITS.maxTextLength + 1);
  assert.equal(
    validateSendInput({ episodeId: 8, playTimeMs: 0, text: over }).some(
      (e) => e.field === "text",
    ),
    true,
  );
});

test("validateSendInput 拒绝越界颜色与非法位置", () => {
  assert.equal(
    validateSendInput({ episodeId: 8, playTimeMs: 0, text: "x", color: 0x1000000 }).some(
      (e) => e.field === "color",
    ),
    true,
  );
  assert.equal(
    validateSendInput({
      episodeId: 8,
      playTimeMs: 0,
      text: "x",
      location: 9 as never,
    }).some((e) => e.field === "location"),
    true,
  );
});

test("normalizeQuery 夹紧 limit 到硬上限", () => {
  assert.equal(normalizeQuery({ episodeId: 8, limit: 999999 }).limit, DANMAKU_LIMITS.maxLimit);
  assert.equal(normalizeQuery({ episodeId: 8, limit: 0 }).limit, 1);
  assert.equal(
    normalizeQuery({ episodeId: 8 }).limit,
    DANMAKU_LIMITS.defaultLimit,
  );
});

test("normalizeQuery 反转倒序时间窗并收敛到最大跨度", () => {
  const swapped = normalizeQuery({ episodeId: 8, fromMs: 5000, toMs: 1000 });
  assert.equal(swapped.fromMs, 1000);
  assert.equal(swapped.toMs, 5000);

  const huge = normalizeQuery({ episodeId: 8, fromMs: 0, toMs: 10 ** 9 });
  assert.equal(huge.toMs! - huge.fromMs!, DANMAKU_LIMITS.maxWindowMs);
});

test("normalizeQuery 在 schoolOnly 缺 schoolId 时抛错", () => {
  assert.throws(() => normalizeQuery({ episodeId: 8, schoolOnly: true }), /schoolId/);
  assert.doesNotThrow(() =>
    normalizeQuery({ episodeId: 8, schoolOnly: true, schoolId: "hit" }),
  );
});

test("sliceByTimeWindow 为闭区间", () => {
  const list = [dto({ id: "a", playTimeMs: 100 }), dto({ id: "b", playTimeMs: 200 }), dto({ id: "c", playTimeMs: 300 })];
  assert.deepEqual(
    sliceByTimeWindow(list, 100, 200).map((d) => d.id),
    ["a", "b"],
  );
  assert.deepEqual(sliceByTimeWindow(list).length, 3);
  assert.deepEqual(sliceByTimeWindow(list, 250).map((d) => d.id), ["c"]);
});

test("filterBySchool 只保留本校弹幕", () => {
  const list = [dto({ id: "a", schoolId: "hit" }), dto({ id: "b", schoolId: "other" })];
  assert.deepEqual(
    filterBySchool(list, "hit").map((d) => d.id),
    ["a"],
  );
});

test("sortByPlayTime 升序且同刻按 id 稳定", () => {
  const list = [
    dto({ id: "c", playTimeMs: 300 }),
    dto({ id: "b", playTimeMs: 100 }),
    dto({ id: "a", playTimeMs: 100 }),
  ];
  assert.deepEqual(
    sortByPlayTime(list).map((d) => d.id),
    ["a", "b", "c"],
  );
});

test("allocateTracks 把同时刻滚动弹幕分散到不同轨道", () => {
  const list = [
    dto({ id: "a", playTimeMs: 0, text: "aaaa" }),
    dto({ id: "b", playTimeMs: 0, text: "bbbb" }),
    dto({ id: "c", playTimeMs: 0, text: "cccc" }),
  ];
  const assigned = allocateTracks(list, { trackCount: 3, viewportWidth: 800 });
  assert.equal(new Set(assigned.map((a) => a.track)).size, 3);
});

test("allocateTracks 在轨道用尽时仍保留全部弹幕（宁可重叠不丢）", () => {
  const list = Array.from({ length: 10 }, (_, i) =>
    dto({ id: `d${i}`, playTimeMs: 0, text: "xxxxxxxx" }),
  );
  const assigned = allocateTracks(list, { trackCount: 2, viewportWidth: 800 });
  assert.equal(assigned.length, 10);
  assert.equal(Math.max(...assigned.map((a) => a.track)) < 2, true);
});

test("allocateTracks 时间错开后复用同一轨道", () => {
  const list = [
    dto({ id: "a", playTimeMs: 0, text: "x" }),
    dto({ id: "b", playTimeMs: 60_000, text: "y" }),
  ];
  const assigned = allocateTracks(list, { trackCount: 4, viewportWidth: 800 });
  assert.equal(assigned[0].track, assigned[1].track);
});

test("allocateTracks 对 TOP/BOTTOM 独立计轨道，trackCount 为 0 时返回空", () => {
  const list = [
    dto({ id: "t", playTimeMs: 0, location: DanmakuLocation.Top }),
    dto({ id: "b", playTimeMs: 0, location: DanmakuLocation.Bottom }),
  ];
  const assigned = allocateTracks(list, { trackCount: 4, viewportWidth: 800 });
  assert.equal(assigned.length, 2);
  assert.deepEqual(allocateTracks(list, { trackCount: 0, viewportWidth: 800 }), []);
});

test("summarize 统计位置分布与去重发送者", () => {
  const list = [
    dto({ id: "a", location: DanmakuLocation.Normal, senderId: "u1" }),
    dto({ id: "b", location: DanmakuLocation.Top, senderId: "u1" }),
    dto({ id: "c", location: DanmakuLocation.Bottom, senderId: "u2" }),
  ];
  assert.deepEqual(summarize(list), {
    total: 3,
    normal: 1,
    top: 1,
    bottom: 1,
    uniqueSenders: 2,
  });
});

test("locationToName 映射到 Animeko 的位置枚举名", () => {
  assert.equal(locationToName(DanmakuLocation.Normal), "NORMAL");
  assert.equal(locationToName(DanmakuLocation.Top), "TOP");
  assert.equal(locationToName(DanmakuLocation.Bottom), "BOTTOM");
});

test("TokenBucketLimiter 允许突发后限流，并随时间恢复", () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1 }, () => now);

  assert.equal(limiter.consume("u1").allowed, true);
  assert.equal(limiter.consume("u1").allowed, true);
  assert.equal(limiter.consume("u1").allowed, true);

  const denied = limiter.consume("u1");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1000);

  // 桶独立：另一个用户不受影响
  assert.equal(limiter.consume("u2").allowed, true);

  now = 2000;
  assert.equal(limiter.consume("u1").allowed, true);
});

test("TokenBucketLimiter.prune 回收不活跃的桶", () => {
  let now = 0;
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 }, () => now);
  limiter.consume("u1");
  assert.equal(limiter.size, 1);

  now = 10 * 60 * 1000 + 1;
  limiter.prune();
  assert.equal(limiter.size, 0);
});

/* ---------------------------------------------------------------- *
 * shouldRefill —— 服务端上限截断时的补充判定
 * ---------------------------------------------------------------- */

test("shouldRefill 距末尾远时不补充", () => {
  // 播放在开头，已加载到 17 分钟 —— 还有大把没播，不需要补
  assert.equal(shouldRefill(1_033_000, 0), false);
  assert.equal(shouldRefill(1_033_000, 500_000), false);
  assert.equal(shouldRefill(1_033_000, 972_999), false, "差 60001ms 不该触发");
});

test("shouldRefill 距末尾 60 秒内时补充", () => {
  assert.equal(shouldRefill(1_033_000, 973_000), true, "恰好差 60000ms 应触发");
  assert.equal(shouldRefill(1_033_000, 1_000_000), true);
  assert.equal(shouldRefill(1_033_000, 1_033_000), true, "恰好到末尾应触发");
});

test("shouldRefill 在播过末尾时也补充", () => {
  // remaining 为负说明还没加载完就该补 —— 不能因为「超了」就不管
  assert.equal(shouldRefill(1_033_000, 1_100_000), true);
  assert.equal(shouldRefill(1000, 999_999), true);
});

test("shouldRefill 未加载任何弹幕时不补充（首屏请求负责）", () => {
  assert.equal(shouldRefill(0, 0), false);
  assert.equal(shouldRefill(-1, 0), false);
  assert.equal(shouldRefill(Number.NaN, 0), false);
});

test("shouldRefill 支持自定义阈值", () => {
  assert.equal(shouldRefill(10_000, 0, 5_000), false);
  assert.equal(shouldRefill(10_000, 6_000, 5_000), true);
});

test("shouldRefill 与切片配合能覆盖被截断的部分", () => {
  // 场景：服务端返回前 2000 条（末尾 1033 秒），实际还有 563 条到 1913 秒。
  // 播到 1033 秒时应触发补充 —— 这正是「库里有几千条、播放时只看到一部分」的修复点。
  const loadedMaxMs = 1_033_000;
  assert.equal(shouldRefill(loadedMaxMs, 900_000), false, "还有 133 秒，先不补");
  assert.equal(shouldRefill(loadedMaxMs, 990_000), true, "只剩 43 秒，该补了");
});

/* ---------------------------------------------------------------- *
 * mergeById —— 多来源合并去重（首屏 / 实时增量 / 按需补充）
 * ---------------------------------------------------------------- */

test("mergeById 合并两个不重叠的批次并按时间排序", () => {
  const existing = [dto({ id: "a", playTimeMs: 100 }), dto({ id: "b", playTimeMs: 200 })];
  const incoming = [dto({ id: "c", playTimeMs: 50 })];
  assert.deepEqual(
    mergeById(existing, incoming).map((d) => d.id),
    ["c", "a", "b"],
  );
});

test("mergeById 去除重复 id（补充窗口与已有数据交叉时）", () => {
  // 这是真实场景：refill 的窗口可能与已加载数据部分重叠
  const existing = [dto({ id: "a", playTimeMs: 100 }), dto({ id: "b", playTimeMs: 200 })];
  const incoming = [dto({ id: "b", playTimeMs: 200 }), dto({ id: "c", playTimeMs: 300 })];
  const merged = mergeById(existing, incoming);
  assert.deepEqual(merged.map((d) => d.id), ["a", "b", "c"]);
  assert.equal(merged.filter((d) => d.id === "b").length, 1, "重复 id 只应保留一条");
});

test("mergeById 全部重复时返回等价内容", () => {
  const existing = [dto({ id: "a" }), dto({ id: "b" })];
  const merged = mergeById(existing, [dto({ id: "a" }), dto({ id: "b" })]);
  assert.equal(merged.length, 2);
});

test("mergeById 空增量不改变内容", () => {
  const existing = [dto({ id: "a" })];
  assert.deepEqual(mergeById(existing, []).map((d) => d.id), ["a"]);
});

test("mergeById 对空初始集可用（首个增量到达前）", () => {
  assert.deepEqual(mergeById([], [dto({ id: "a" })]).map((d) => d.id), ["a"]);
});

test("mergeById 不修改入参数组", () => {
  const existing = [dto({ id: "a" })];
  const incoming = [dto({ id: "b" })];
  mergeById(existing, incoming);
  assert.equal(existing.length, 1);
  assert.equal(incoming.length, 1);
});
