/**
 * 弹幕显示样式测试。
 *
 * ## 防的是什么
 *
 * 这个模块把「用户拖的滑块」翻译成「实际绘制参数」，两处都容易**静默失效**：
 *
 * 1. **位置判定用错枚举值** —— 实测踩过：我按 BGM API 的 `5`=顶部 / `4`=底部
 *    写，而本仓库的 `DanmakuLocation` 是 `Normal:0, Top:1, Bottom:2`。
 *    结果「顶部」「底部」两个开关**永远不生效**，而关掉「滚动」会把**所有**
 *    弹幕一起藏掉 —— 没有任何报错。
 * 2. **localStorage 的值不可信** —— 用户可改写，越界的 `fontSize` 会让 canvas
 *    卡死。必须逐字段夹取。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DanmakuLocation } from "@/lib/danmaku/types";
import {
  BASE_TRACK_COUNT,
  DANMAKU_LIMITS,
  DEFAULT_DANMAKU_STYLE,
  danmakuLayout,
  normalizeDanmakuStyle,
  shouldRenderDanmaku,
  type DanmakuStyle,
} from "@/lib/danmaku/style";

const style = (over: Partial<DanmakuStyle> = {}): DanmakuStyle => ({
  ...DEFAULT_DANMAKU_STYLE,
  ...over,
});

/* ================================================================== *
 * 位置判定 —— 本文件存在的首要理由
 * ================================================================== */

test("用**本仓库**的枚举值：Top=1 / Bottom=2（不是 BGM 的 5/4）", () => {
  // 这条锁死「用哪个数值」。写错时开关静默失效，只有这里能抓到。
  assert.equal(DanmakuLocation.Normal, 0);
  assert.equal(DanmakuLocation.Top, 1);
  assert.equal(DanmakuLocation.Bottom, 2);
});

test("关掉「顶部」只影响顶部弹幕 —— 不影响滚动与底部", () => {
  const s = style({ showTop: false });
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Top), false);
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Normal), true, "滚动弹幕不该被连带关掉");
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Bottom), true, "底部弹幕不该被连带关掉");
});

test("关掉「底部」只影响底部弹幕", () => {
  const s = style({ showBottom: false });
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Bottom), false);
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Normal), true);
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Top), true);
});

test("关掉「滚动」只影响滚动弹幕 —— 顶部与底部仍在", () => {
  // 这是踩过的那条：位置判定用错数值时，关「滚动」会把**所有**弹幕藏掉。
  const s = style({ showScroll: false });
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Normal), false);
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Top), true, "顶部弹幕不该被连带关掉");
  assert.equal(shouldRenderDanmaku(s, DanmakuLocation.Bottom), true, "底部弹幕不该被连带关掉");
});

test("总开关关掉时，三种位置都不画", () => {
  const s = style({ enabled: false });
  for (const loc of [DanmakuLocation.Normal, DanmakuLocation.Top, DanmakuLocation.Bottom]) {
    assert.equal(shouldRenderDanmaku(s, loc), false);
  }
});

test("未知位置值按滚动处理（上游将来新增类型时不该整条消失）", () => {
  assert.equal(shouldRenderDanmaku(style(), 99), true);
  assert.equal(shouldRenderDanmaku(style({ showScroll: false }), 99), false);
});

/* ================================================================== *
 * 归一化 —— localStorage 的值不可信
 * ================================================================== */

test("非法输入退回默认值（不抛错）", () => {
  for (const bad of [null, undefined, 42, "x", []]) {
    assert.deepEqual(normalizeDanmakuStyle(bad), DEFAULT_DANMAKU_STYLE);
  }
});

test("越界的数值被夹到区间内 —— 否则超大字号会让 canvas 卡死", () => {
  const s = normalizeDanmakuStyle({ fontSize: 1e9, opacity: 99, area: -5, speed: 0 });
  assert.equal(s.fontSize, DANMAKU_LIMITS.fontSize.max);
  assert.equal(s.opacity, DANMAKU_LIMITS.opacity.max);
  assert.equal(s.area, DANMAKU_LIMITS.area.min);
  assert.equal(s.speed, DANMAKU_LIMITS.speed.min);
});

test("NaN / Infinity 退回默认（夹取对它们无效）", () => {
  const s = normalizeDanmakuStyle({ fontSize: Number.NaN, opacity: Number.POSITIVE_INFINITY });
  assert.equal(s.fontSize, DEFAULT_DANMAKU_STYLE.fontSize);
  assert.equal(s.opacity, DEFAULT_DANMAKU_STYLE.opacity);
});

test("布尔字段只认 true / false", () => {
  // `"false"` 字符串之类不该被当成 true，也不该把字段丢掉
  const s = normalizeDanmakuStyle({ enabled: false, showTop: false, showScroll: 0 });
  assert.equal(s.enabled, false);
  assert.equal(s.showTop, false);
  assert.equal(s.showScroll, true, "非 false 的怪值按「开」处理（默认开）");
});

test("只给部分字段时，其余仍取默认", () => {
  const s = normalizeDanmakuStyle({ fontSize: 24 });
  assert.equal(s.fontSize, 24);
  assert.equal(s.opacity, DEFAULT_DANMAKU_STYLE.opacity);
  assert.equal(s.area, DEFAULT_DANMAKU_STYLE.area);
  assert.equal(s.speed, DEFAULT_DANMAKU_STYLE.speed);
});

/* ================================================================== *
 * 布局换算
 * ================================================================== */

test("默认样式与改动前的硬编码等价（老用户观感不变）", () => {
  const layout = danmakuLayout(DEFAULT_DANMAKU_STYLE);
  assert.equal(layout.trackCount, BASE_TRACK_COUNT, "默认轨道数应仍是 8");
  assert.equal(layout.trackHeight, 26, "默认行高应仍是 26");
  assert.equal(layout.canvasHeight, 208, "默认画布高应仍是 8×26");
  assert.equal(layout.charWidth, 16, "默认字宽应仍是 16");
  assert.equal(layout.speedPxPerMs, 0.18, "默认速度应仍是 0.18");
});

test("字号调大后行高跟着长 —— 否则文字会上下压在一起", () => {
  const big = danmakuLayout(style({ fontSize: 32 }));
  assert.ok(big.trackHeight > danmakuLayout(DEFAULT_DANMAKU_STYLE).trackHeight * 1.5);
});

test("「显示区域」直接决定轨道数与画布高度", () => {
  const half = danmakuLayout(style({ area: 0.5 }));
  assert.equal(half.trackCount, 4);
  assert.equal(half.canvasHeight, half.trackCount * half.trackHeight);
  // 区域小则画布也矮 —— 不留一块空白挡着视频
  assert.ok(half.canvasHeight < danmakuLayout(DEFAULT_DANMAKU_STYLE).canvasHeight);
});

test("区域调到最小时仍有至少一条轨道（而不是什么都不画）", () => {
  const tiny = danmakuLayout(style({ area: 0.01 }));
  assert.ok(tiny.trackCount >= 1, `至少 1 条轨，实际 ${tiny.trackCount}`);
  assert.ok(tiny.canvasHeight > 0);
});

test("速度倍率线性作用于像素速度", () => {
  assert.equal(danmakuLayout(style({ speed: 2 })).speedPxPerMs, 0.36);
  assert.equal(danmakuLayout(style({ speed: 0.5 })).speedPxPerMs, 0.09);
});
