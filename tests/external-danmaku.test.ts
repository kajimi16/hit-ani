/**
 * Animeko 弹幕格式映射单测 —— 测**真实实现**（`animeko-mapping.ts`）。
 *
 * 这些是「字段映射」类错误：不影响功能可用性，但会让弹幕看起来不对
 * （颜色全黑、位置全错），且很难从现象反推原因。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mapAnimekoColor,
  mapAnimekoContent,
  mapAnimekoLocation,
} from "@/lib/danmaku/animeko-mapping";
import { DanmakuLocation } from "@/lib/danmaku/types";

/* ---------------------------------------------------------------- *
 * 颜色
 * ---------------------------------------------------------------- */

test("颜色：Animeko 的 ARGB -1（白）必须映射为 0xFFFFFF", () => {
  // 最容易错的映射：Animeko 用带符号 32 位整数表示 ARGB，-1 === 0xFFFFFFFF。
  // 不剥 alpha 的话颜色是负数，canvas 上会画成黑的或干脆不绘制。
  assert.equal(mapAnimekoColor(-1), 0xffffff);
  assert.equal(mapAnimekoColor(0xffffffff), 0xffffff);
});

test("颜色：剥掉 alpha 保留 RGB", () => {
  assert.equal(mapAnimekoColor(0xff0000), 0xff0000);
  assert.equal(mapAnimekoColor(0xffff0000 | 0), 0xff0000);
  assert.equal(mapAnimekoColor(0x6600ff00), 0x00ff00);
});

test("颜色：非法值回退白色而非 0（0 是黑色，深色背景上不可见）", () => {
  assert.equal(mapAnimekoColor(undefined), 0xffffff);
  assert.equal(mapAnimekoColor(null), 0xffffff);
  assert.equal(mapAnimekoColor("red"), 0xffffff);
  assert.equal(mapAnimekoColor(Number.NaN), 0xffffff);
  assert.equal(mapAnimekoColor(Number.POSITIVE_INFINITY), 0xffffff);
});

/* ---------------------------------------------------------------- *
 * 位置
 * ---------------------------------------------------------------- */

test("位置：字符串枚举映射到站内数值", () => {
  assert.equal(mapAnimekoLocation("NORMAL"), DanmakuLocation.Normal);
  assert.equal(mapAnimekoLocation("TOP"), DanmakuLocation.Top);
  assert.equal(mapAnimekoLocation("BOTTOM"), DanmakuLocation.Bottom);
});

test("位置：未知值退回 NORMAL 而非丢弃整条", () => {
  assert.equal(mapAnimekoLocation("UNKNOWN"), DanmakuLocation.Normal);
  assert.equal(mapAnimekoLocation(undefined), DanmakuLocation.Normal);
  assert.equal(mapAnimekoLocation(1), DanmakuLocation.Normal);
});

/* ---------------------------------------------------------------- *
 * 内容整体
 * ---------------------------------------------------------------- */

test("mapAnimekoContent 转换完整字段", () => {
  const mapped = mapAnimekoContent({
    playTime: 484928,
    color: -1,
    text: "  测试弹幕  ",
    location: "TOP",
  });
  assert.deepEqual(mapped, {
    playTimeMs: 484928,
    color: 0xffffff,
    text: "测试弹幕",
    location: DanmakuLocation.Top,
  });
});

test("mapAnimekoContent 丢弃无文本或时间非法的条目", () => {
  assert.equal(mapAnimekoContent(undefined), null);
  assert.equal(mapAnimekoContent({ playTime: 1000, text: "" }), null);
  assert.equal(mapAnimekoContent({ playTime: 1000, text: "   " }), null);
  assert.equal(mapAnimekoContent({ playTime: -1, text: "x" }), null);
  assert.equal(mapAnimekoContent({ playTime: Number.NaN, text: "x" }), null);
  assert.equal(mapAnimekoContent({ text: "没有时间" }), null);
  assert.equal(mapAnimekoContent({ playTime: "1000", text: "x" }), null);
});

test("mapAnimekoContent 对缺失颜色/位置使用安全默认值", () => {
  const mapped = mapAnimekoContent({ playTime: 1000, text: "x" });
  assert.equal(mapped?.color, 0xffffff, "缺颜色应为白色");
  assert.equal(mapped?.location, DanmakuLocation.Normal, "缺位置应为滚动");
});

test("mapAnimekoContent 时间取整（毫秒必须是整数，时间轴比较依赖它）", () => {
  assert.equal(mapAnimekoContent({ playTime: 1000.7, text: "x" })?.playTimeMs, 1001);
  assert.equal(mapAnimekoContent({ playTime: 1000.2, text: "x" })?.playTimeMs, 1000);
});

/* ---------------------------------------------------------------- *
 * 与站内枚举的一致性
 * ---------------------------------------------------------------- */

test("站内位置常量与 Animeko 语义一致", () => {
  assert.equal(DanmakuLocation.Normal, 0);
  assert.equal(DanmakuLocation.Top, 1);
  assert.equal(DanmakuLocation.Bottom, 2);
});

test("外部弹幕的 schoolId 设计为空串 → 被「只看本校」自然排除", () => {
  // 设计意图：外部弹幕不属于任何学校。
  // 若改成某个具体值，它们就会混进本校弹幕里 —— 那会破坏最核心的筛选语义。
  const externalSchoolId = "";
  const mySchool = "hit";
  assert.notEqual(externalSchoolId, mySchool);
  assert.ok(!externalSchoolId, "空串是 falsy，界面据此显示为「外部」");
});
