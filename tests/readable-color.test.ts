/**
 * 弹幕颜色可读性测试。
 *
 * ## 为什么需要
 *
 * 弹幕颜色由发送者指定，而我们的界面是深色 —— 实测 2000 条弹幕里
 * **339 条（17%）在深色背景上不可读**（深蓝 1.63:1、深灰 1.32:1）。
 * 这不是"某个颜色没选好"，而是深色主题 + 用户自定义颜色的必然冲突：
 * 发送者是在浅色播放器里挑的颜色。
 *
 * 这组测试锁死三件事：
 *  1. 调整后**一定**可读（对所有可能的输入）
 *  2. 已经可读的颜色**不被改动**（不能把所有弹幕都洗成白色）
 *  3. 色相尽量保留（可读但无色相的弹幕墙就失去了弹幕文化的一部分）
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIN_DANMAKU_CONTRAST,
  ensureReadableColor,
  isAdjusted,
  readableDanmakuColor,
  toCssColor,
} from "@/lib/danmaku/readable-color";

/* ---------------------------------------------------------------- *
 * 对比度计算（独立实现，避免"用被测代码验证自己"）
 * ---------------------------------------------------------------- */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** 最亮的深色背景 `#212630` —— 最不利的情形。 */
const WORST_BACKDROP = luminance(0x212630);

function contrastOnWorstBackdrop(color: number): number {
  const a = luminance(color);
  const [hi, lo] = a > WORST_BACKDROP ? [a, WORST_BACKDROP] : [WORST_BACKDROP, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------------- *
 * 核心保证：调整后一定可读
 * ---------------------------------------------------------------- */

test("所有严重不达标的颜色都被调整到可读", () => {
  const problematic = [
    0x000000, // 纯黑
    0x222222, // 深灰，实测 1.32:1
    0x002e72, // 深蓝，实测 1.63:1
    0x683a7b, // 紫，实测 2.48:1
    0xc60012, // 红，实测 4.41:1（差一点）
    0x0000ff, // 纯蓝
    0x800000, // 暗红
    0x004400, // 暗绿
  ];

  for (const original of problematic) {
    const adjusted = ensureReadableColor(original);
    const ratio = contrastOnWorstBackdrop(adjusted);
    assert.ok(
      ratio >= MIN_DANMAKU_CONTRAST,
      `#${original.toString(16).padStart(6, "0")} → #${adjusted
        .toString(16)
        .padStart(6, "0")} 仅 ${ratio.toFixed(2)}:1`,
    );
  }
});

test("穷尽 24 位色空间的一个大样本，全部可读", () => {
  // 用一个确定性的伪随机序列覆盖各种色相与明度组合。
  // 单纯测几个手挑的颜色不足以证明算法对所有输入成立。
  let seed = 12345;
  const nextByte = () => {
    // xorshift，确定性 → 失败可复现
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return Math.abs(seed) % 256;
  };

  for (let i = 0; i < 20000; i += 1) {
    const original = (nextByte() << 16) | (nextByte() << 8) | nextByte();
    const adjusted = ensureReadableColor(original);
    const ratio = contrastOnWorstBackdrop(adjusted);
    assert.ok(
      ratio >= MIN_DANMAKU_CONTRAST,
      `样本 ${i}: #${original.toString(16).padStart(6, "0")} → #${adjusted
        .toString(16)
        .padStart(6, "0")} 仅 ${ratio.toFixed(2)}:1（要求 ${MIN_DANMAKU_CONTRAST}）`,
    );
  }
});

test("输出始终是合法的 24 位颜色（不会越界或为负）", () => {
  for (const original of [0x000000, 0xffffff, 0x010203, 0xfefdfc, 0x123456]) {
    const adjusted = ensureReadableColor(original);
    assert.ok(adjusted >= 0 && adjusted <= 0xffffff, `越界：${adjusted}`);
    assert.equal(adjusted, Math.floor(adjusted), "必须是整数");
  }
});

/* ---------------------------------------------------------------- *
 * 不过度处理
 * ---------------------------------------------------------------- */

test("已经可读的颜色不被改动", () => {
  // 若把所有弹幕都洗成白色，虽然"可读"了，但弹幕墙会失去色彩，
  // 「保留色相」这个设计目标就落空了。
  const alreadyReadable = [
    0xffffff, // 白
    0x66ccff, // 浅蓝（BGM 常见的弹幕色）
    0xffcc00, // 金黄
    0x99ff99, // 浅绿
  ];

  for (const color of alreadyReadable) {
    assert.equal(
      ensureReadableColor(color),
      color,
      `#${color.toString(16).padStart(6, "0")} 本就可读，不该被改`,
    );
    assert.equal(isAdjusted(color), false);
  }
});

test("提亮后色相仍与原始相关（不是一律变白）", () => {
  // 紫色提亮后应当仍是偏紫，而不是白色。
  const purple = ensureReadableColor(0x683a7b);
  const r = (purple >> 16) & 0xff;
  const g = (purple >> 8) & 0xff;
  const b = purple & 0xff;
  assert.notEqual(purple, 0xffffff, "不该直接变成白色");
  assert.ok(b > g && r > g, `提亮后应仍偏紫（实际 r=${r} g=${g} b=${b}）`);
});

test("纯红提亮后保持红色分量最高", () => {
  const red = ensureReadableColor(0xff0000);
  const r = (red >> 16) & 0xff;
  const g = (red >> 8) & 0xff;
  const b = red & 0xff;
  assert.ok(r >= g && r >= b, `提亮后应仍是最红（实际 ${red.toString(16)}）`);
});

/* ---------------------------------------------------------------- *
 * 极端输入
 * ---------------------------------------------------------------- */

test("纯黑被提亮为中性灰，且色相中性（R=G=B）", () => {
  // 纯黑没有色相可言，但它仍可被提亮成**中性灰** ——
  // 算法只在连提亮都达不到对比度时才回退白色。
  // 保留中性灰比一律变白更好：弹幕墙里"默认白"与"用户选的深色"仍可区分。
  const black = ensureReadableColor(0x000000);
  const r = (black >> 16) & 0xff;
  const g = (black >> 8) & 0xff;
  const b = black & 0xff;

  assert.ok(contrastOnWorstBackdrop(black) >= MIN_DANMAKU_CONTRAST, "必须达标");
  assert.equal(r, g, "中性灰的 R 与 G 应相等");
  assert.equal(g, b, "中性灰的 G 与 B 应相等");
});
test("边界值 0x000000 与 0xffffff 都不抛错", () => {
  assert.doesNotThrow(() => readableDanmakuColor(0x000000));
  assert.doesNotThrow(() => readableDanmakuColor(0xffffff));
});

/* ---------------------------------------------------------------- *
 * CSS 输出
 * ---------------------------------------------------------------- */

test("toCssColor 补齐前导零", () => {
  // 这个 bug 专门影响暗色弹幕：`0x0000ff` 若写成 `#ff`，
  // 浏览器解析为无效值，弹幕会变成继承色（而非蓝色）。
  assert.equal(toCssColor(0x0000ff), "#0000ff");
  assert.equal(toCssColor(0x000001), "#000001");
  assert.equal(toCssColor(0xffffff), "#ffffff");
  assert.equal(toCssColor(0xffcc00), "#ffcc00");
});

test("toCssColor 输出可被 CSS 解析为 RGB", () => {
  for (const color of [0x000000, 0x0000ff, 0x66ccff, 0xffffff]) {
    const css = toCssColor(color);
    assert.match(css, /^#[0-9a-f]{6}$/, `${css} 不是合法的 6 位十六进制`);
  }
});

/* ---------------------------------------------------------------- *
 * 真实场景
 * ---------------------------------------------------------------- */

test("本项目实测不可读的那几条颜色都被修正", () => {
  // 这些是从真实弹幕数据里提取的（页面上实测对比度不达标的例子）
  const realCases = [
    { original: 0x002e72, label: "深蓝 1.63:1" },
    { original: 0x222222, label: "深灰 1.32:1" },
    { original: 0x683a7b, label: "紫 2.48:1" },
    { original: 0xc60012, label: "红 4.41:1" },
  ];

  for (const { original, label } of realCases) {
    const adjusted = ensureReadableColor(original);
    const ratio = contrastOnWorstBackdrop(adjusted);
    assert.ok(
      ratio >= MIN_DANMAKU_CONTRAST,
      `${label}: 调整后仍只有 ${ratio.toFixed(2)}:1`,
    );
    assert.ok(isAdjusted(original), `${label} 应被标记为已调整`);
  }
});
