/**
 * 评分直方图归一化测试。
 *
 * `rating.count` 是**外部 JSON**（BGM 返回 → 存进 Json 列 → 再读回来），
 * 形状不可信。渲染层依赖「恰好 10 个非负数」这个前提，因此这里把它当作
 * 不可信输入来测：缺键、脏值、负数、非对象都不能让页面画出坏柱子。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { hasHistogramData, histogramBars } from "@/lib/subject/rating";

test("总是返回 10 根柱，分数从 1 到 10", () => {
  const bars = histogramBars({});
  assert.equal(bars.length, 10);
  assert.deepEqual(
    bars.map((bar) => bar.score),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test("缺失的分数补 0，而不是跳过或错位", () => {
  // 只给 "8" 时，8 必须落在第 8 根，不能因为前面没有键就整体前移。
  const bars = histogramBars({ "8": 100 });
  assert.equal(bars[7].score, 8);
  assert.equal(bars[7].count, 100);
  assert.equal(bars.filter((bar) => bar.count === 0).length, 9);
});

test("百分比按最大值归一，最高的那根是 100%", () => {
  // 按总数归一会让 10 分那根永远只有两三成高，看不出分布形状 ——
  // Animeko 的 RatingHistogram 也是按最大值归一。
  const bars = histogramBars({ "7": 921, "8": 2708, "9": 3111, "10": 982 });
  const nine = bars.find((bar) => bar.score === 9)!;
  assert.equal(nine.percent, 100);
  assert.ok(Math.abs(bars.find((b) => b.score === 8)!.percent - (2708 / 3111) * 100) < 1e-9);
});

test("计数为 0 的柱子高度为 0 —— 不画出不存在的柱子", () => {
  const bars = histogramBars({ "5": 10 });
  for (const bar of bars) {
    if (bar.count === 0) assert.equal(bar.percent, 0, `${bar.score} 分没有数据，不该有高度`);
  }
});

test("有数据但极小的柱子仍可见（最低 6%）", () => {
  // 否则 1 分只有 1 人时柱子高度不足 1 像素，等于看不到。
  const bars = histogramBars({ "1": 1, "10": 100000 });
  assert.ok(bars[0].percent >= 6, `1 分只有 ${bars[0].percent}%，会看不见`);
});

test("脏输入不会污染结果", () => {
  const bars = histogramBars({
    "1": -5, // 负数
    "2": Number.NaN,
    "3": Number.POSITIVE_INFINITY,
    "4": "很多", // 字符串
    "5": null,
    "6": undefined,
    "7": 42, // 唯一合法值
  });
  assert.deepEqual(
    bars.filter((bar) => bar.count > 0).map((bar) => [bar.score, bar.count]),
    [[7, 42]],
  );
  for (const bar of bars) {
    assert.ok(Number.isFinite(bar.count) && bar.count >= 0, `${bar.score} 分得到 ${bar.count}`);
    assert.ok(Number.isFinite(bar.percent) && bar.percent >= 0 && bar.percent <= 100);
  }
});

test("非对象输入（null / 数组 / 字符串 / 数字）一律当作「没有数据」", () => {
  // 数组尤其要挡住：`typeof [] === "object"`，不排除的话 `[]["1"]` 会取到
  // undefined，虽然结果同样是 0，但语义上它根本不是直方图。
  for (const input of [null, undefined, [], ["a"], "{}", 42, true]) {
    const bars = histogramBars(input);
    assert.equal(bars.length, 10, `输入 ${JSON.stringify(input)} 应得到 10 根空柱`);
    assert.equal(hasHistogramData(bars), false);
  }
});

test("全部为 0 时不算「有数据」（不该显示这个板块）", () => {
  assert.equal(hasHistogramData(histogramBars({ "1": 0, "2": 0 })), false);
  assert.equal(hasHistogramData(histogramBars({})), false);
  assert.equal(hasHistogramData(histogramBars({ "6": 1 })), true);
});

test("用真实数据跑一遍（条目 493016）", () => {
  const bars = histogramBars({
    "1": 21, "2": 6, "3": 17, "4": 23, "5": 60,
    "6": 187, "7": 921, "8": 2708, "9": 3111, "10": 982,
  });
  assert.equal(hasHistogramData(bars), true);
  assert.equal(bars.find((bar) => bar.score === 9)!.percent, 100);
  // 分布峰值在 9 分，形状上应该是先增后减，9 分那根最高
  assert.equal(Math.max(...bars.map((bar) => bar.count)), 3111);
});

test("显示顺序是 10 → 1（页面渲染时反转，数据本身仍升序）", () => {
  // 用户要求柱状图 10 在左、1 在右。数据层保持 1→10 升序（排序语义不该被
  // 显示需求污染），由渲染层反转 —— 这里锁住「反转后确实从 10 开始」。
  const bars = histogramBars({ "1": 21, "8": 2708, "9": 3111, "10": 982 });
  const displayed = [...bars].reverse();
  assert.equal(displayed[0].score, 10, "最左边应当是 10 分");
  assert.equal(displayed[displayed.length - 1].score, 1, "最右边应当是 1 分");
  // 反转不改变每根柱子的数据
  assert.equal(displayed[0].count, 982);
  assert.equal(displayed[0].percent, bars.find((b) => b.score === 10)!.percent);
  // 反转结果覆盖全部 10 个分数，无重复无遗漏
  assert.deepEqual(
    [...new Set(displayed.map((b) => b.score))].sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});
