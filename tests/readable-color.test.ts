/**
 * 弹幕颜色可读性测试。
 *
 * ## 为什么这些断言重要
 *
 * 弹幕颜色由**发送者**指定，而它们是在浅色播放器里挑的、在我们的深色界面
 * 上显示。实测 2000 条里 339 条（17%）不可读 —— 且**没有任何功能测试能发现**：
 * 弹幕在、接口 200、canvas 在画，只是人看不见。
 *
 * ## 背景色是参数（本文件的关键约束）
 *
 * 早先实现把背景色硬编码成四个 RGB 三元组，注释写「与 globals.css 一致」，
 * 但**无任何机制保证**。换主题后数组过期 → 提亮不足 → 弹幕读不清，
 * 而**这个文件的旧版本拿同一份硬编码自测，照样全绿**。
 *
 * 现在背景由调用方传入，因此本文件对**多个真实背景**（明暗两套主题的各层
 * 表面）都做断言，而不是只测一个「最不利」的常量。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MIN_DANMAKU_CONTRAST,
  contrastOutlineFor,
  contrastRatio,
  ensureReadableColor,
  parseCssColor,
  rgbOf,
  toCssColor,
  type Rgb,
} from "@/lib/danmaku/readable-color";

/* ---------------------------------------------------------------- *
 * 对比度计算（独立实现，避免「用被测代码验证自己」）
 * ---------------------------------------------------------------- */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function ratio(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------------------------------------------- *
 * 真实背景 —— 从 globals.css 派生，而不是复制
 * ---------------------------------------------------------------- */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/**
 * 弹幕列表（`.panel` / `bg-surface-container-low`）与播放器页面上
 * 实际可能出现的背景。
 *
 * **必须从 CSS 读**：写死的话换主题后测试不会跟着响，弹幕会悄悄变得
 * 不可读 —— 这正是这条不变量此前失守的原因。
 */
function backdropsFromCss(): { name: string; rgb: Rgb }[] {
  const dark = /^:root\s*\{([\s\S]*?)\n\}/m.exec(CSS)?.[1] ?? "";
  // 浅色是显式 opt-in（`data-theme="light"`），不跟随系统偏好
  const light = /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";

  const roles = ["surface-container-lowest", "surface-container-low", "surface-container", "surface-container-high", "surface-container-highest"];
  const out: { name: string; rgb: Rgb }[] = [];

  for (const [theme, block] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const role of roles) {
      const hex = new RegExp(`--md-${role}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1];
      assert.ok(hex, `${theme} 色板缺少 --md-${role}`);
      out.push({ name: `${theme}/${role}`, rgb: rgbOf(parseInt(hex.slice(1), 16)) });
    }
  }
  return out;
}

const BACKDROPS = backdropsFromCss();

/** 最不利的深色背景（深色主题里最亮的那层）—— 单独保留用于快速断言。 */
const WORST_DARK = BACKDROPS.find((b) => b.name === "dark/surface-container-highest")!.rgb;

/* ---------------------------------------------------------------- *
 * 核心保证：调整后一定可读 —— 对**所有**真实背景
 * ---------------------------------------------------------------- */

test("严重不达标的颜色在全部真实背景上都被调整到可读", () => {
  const problematic = [
    0x000000, // 纯黑
    0x222222, // 深灰，实测深色下 1.32:1
    0x002e72, // 深蓝，实测深色下 1.63:1
    0x683a7b, // 紫，实测深色下 2.48:1
    0xc60012, // 红，实测深色下 4.41:1（差一点）
    0x0000ff, // 纯蓝
    0x800000, // 暗红
    0x004400, // 暗绿
    0xffff00, // 亮黄 —— 浅色背景下的反面案例
    0xffffff, // 白 —— 浅色背景下的反面案例
  ];

  for (const backdrop of BACKDROPS) {
    for (const original of problematic) {
      const { color } = ensureReadableColor(original, backdrop.rgb);
      const r = ratio(rgbOf(color), backdrop.rgb);
      assert.ok(
        r >= MIN_DANMAKU_CONTRAST,
        `${backdrop.name}：#${original.toString(16).padStart(6, "0")} → #${color
          .toString(16)
          .padStart(6, "0")} 仅 ${r.toFixed(2)}:1`,
      );
    }
  }
});

test("穷尽采样：20000 个随机颜色 × 全部真实背景，全部可读", () => {
  // 单纯测几个手挑的颜色不足以证明算法对所有输入成立。
  // 用确定性 xorshift → 失败可复现。
  let seed = 12345;
  const nextByte = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return Math.abs(seed) % 256;
  };

  const samples: number[] = [];
  for (let i = 0; i < 20000; i += 1) {
    samples.push((nextByte() << 16) | (nextByte() << 8) | nextByte());
  }

  for (const backdrop of BACKDROPS) {
    for (let i = 0; i < samples.length; i += 1) {
      const original = samples[i];
      const { color } = ensureReadableColor(original, backdrop.rgb);
      const r = ratio(rgbOf(color), backdrop.rgb);
      assert.ok(
        r >= MIN_DANMAKU_CONTRAST,
        `${backdrop.name} 样本 ${i}: #${original.toString(16).padStart(6, "0")} → #${color
          .toString(16)
          .padStart(6, "0")} 仅 ${r.toFixed(2)}:1`,
      );
    }
  }
});

test("输出始终是合法的 24 位颜色（不会越界或为负）", () => {
  for (const original of [0x000000, 0xffffff, 0x010203, 0xfefdfc, 0x123456]) {
    for (const backdrop of BACKDROPS) {
      const { color } = ensureReadableColor(original, backdrop.rgb);
      assert.ok(color >= 0 && color <= 0xffffff, `越界：${color}`);
      assert.equal(color, Math.floor(color), "必须是整数");
    }
  }
});

/* ---------------------------------------------------------------- *
 * 明暗两套主题方向相反 —— 这是「背景是参数」的核心收益
 * ---------------------------------------------------------------- */

test("深色背景下变亮、浅色背景下变暗", () => {
  // 若一律提亮，浅色主题上弹幕会直接消失。这条断言锁死方向判断。
  const darkBackdrop = rgbOf(0x141218);
  const lightBackdrop = rgbOf(0xfef7ff);

  // 两个背景上分别取一个**确实不可读**的颜色 —— 可读的颜色会被原样返回，
  // 用它测方向会得出错误结论（`#222222` 在浅色底上本来就有 15:1）。
  const onDark = ensureReadableColor(0x222222, darkBackdrop);
  const onLight = ensureReadableColor(0xdddddd, lightBackdrop);

  assert.ok(onDark.adjusted && onLight.adjusted, "用例前提：两者本都不可读");
  assert.ok(
    luminance(rgbOf(onDark.color)) > luminance(rgbOf(0x222222)),
    "深色背景下应当提亮",
  );
  assert.ok(
    luminance(rgbOf(onLight.color)) < luminance(rgbOf(0xdddddd)),
    "浅色背景下应当压暗",
  );
});

test("中灰背景上白色被压暗（不能只看「背景亮度 < 0.5」）", () => {
  // `#7f7f7f` 的亮度是 0.216，远低于 0.5 —— 若按亮度阈值决定方向就会去
  // 提亮白色，而白色本来就已经是最大亮度，contrast 停在 3.95:1 不达标。
  // 正确方向是压暗：对比度交叉点在背景亮度 0.179。
  const midGray = rgbOf(0x7f7f7f);
  assert.ok(
    contrastRatio([255, 255, 255], midGray) < MIN_DANMAKU_CONTRAST,
    "用例前提：白色在中灰上本就不达标",
  );

  const { color, adjusted } = ensureReadableColor(0xffffff, midGray);
  assert.ok(adjusted);
  assert.ok(luminance(rgbOf(color)) < 1, "应当压暗而不是原地不动");
  assert.ok(
    contrastRatio(rgbOf(color), midGray) >= MIN_DANMAKU_CONTRAST,
    "压暗后必须达标",
  );
});

test("跨过对比度交叉点的各种背景上，两个方向的结果都仍然可读", () => {
  // 白/黑交叉点在背景亮度 ≈0.179，`#7f7f7f`(0.216) 与 `#bcbcbc`(0.5) 分别在
  // 两侧 —— 方向判断必须由「哪个极值对比度更高」决定，而不是某个亮度常量。
  for (const backdrop of [rgbOf(0x7f7f7f), rgbOf(0xbcbcbc), rgbOf(0xffffff), rgbOf(0x000000)]) {
    for (const original of [0x000000, 0xffffff, 0x66ccff, 0x222222]) {
      const { color } = ensureReadableColor(original, backdrop);
      assert.ok(
        ratio(rgbOf(color), backdrop) >= MIN_DANMAKU_CONTRAST,
        `背景 ${backdrop.join(",")} 上的 #${original.toString(16)} 不达标`,
      );
    }
  }
});

/* ---------------------------------------------------------------- *
 * 不过度处理
 * ---------------------------------------------------------------- */

test("已经可读的颜色不被改动", () => {
  // 若把所有弹幕都洗成白色，虽然「可读」了，但弹幕墙会失去色彩，
  // 「保留色相」这个设计目标就落空了。
  const alreadyReadable = [
    0xffffff, // 白
    0x66ccff, // 浅蓝（BGM 常见的弹幕色）
    0xffcc00, // 金黄
    0x99ff99, // 浅绿
  ];

  for (const color of alreadyReadable) {
    const result = ensureReadableColor(color, WORST_DARK);
    assert.equal(result.color, color, `#${color.toString(16)} 本就可读，不该被改`);
    assert.equal(result.adjusted, false);
  }
});

test("调整后色相仍与原始相关（不是一律变白）", () => {
  const { color } = ensureReadableColor(0x683a7b, WORST_DARK);
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  assert.notEqual(color, 0xffffff, "不该直接变成白色");
  assert.ok(b > g && r > g, `调整后应仍偏紫（实际 r=${r} g=${g} b=${b}）`);
});

test("纯红调整后保持红色分量最高", () => {
  const { color } = ensureReadableColor(0xff0000, WORST_DARK);
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  assert.ok(r >= g && r >= b, `调整后应仍是最红（实际 ${color.toString(16)}）`);
});

test("纯黑被提亮为中性灰，且色相中性（R=G=B）", () => {
  // 纯黑没有色相可言，但它仍可被提亮成**中性灰** ——
  // 只在连提亮都达不到对比度时才回退纯白。
  // 保留中性灰比一律变白更好：「默认白」与「用户选的深色」仍可区分。
  const { color } = ensureReadableColor(0x000000, WORST_DARK);
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;

  assert.ok(ratio([r, g, b], WORST_DARK) >= MIN_DANMAKU_CONTRAST, "必须达标");
  assert.equal(r, g, "中性灰的 R 与 G 应相等");
  assert.equal(g, b, "中性灰的 G 与 B 应相等");
});

test("边界值 0x000000 与 0xffffff 都不抛错", () => {
  for (const backdrop of BACKDROPS) {
    assert.doesNotThrow(() => ensureReadableColor(0x000000, backdrop.rgb));
    assert.doesNotThrow(() => ensureReadableColor(0xffffff, backdrop.rgb));
  }
});

/* ---------------------------------------------------------------- *
 * canvas 描边色
 * ---------------------------------------------------------------- */

test("描边色与字色亮度相反（亮字配暗描边，反之亦然）", () => {
  // canvas 背景是视频画面，亮度不可知 —— 只能靠「描边与字色相反」保证
  // 任意画面上都有对比。
  assert.match(contrastOutlineFor(0xffffff), /rgba\(0,0,0/, "亮字应配暗描边");
  assert.match(contrastOutlineFor(0xffcc00), /rgba\(0,0,0/, "亮黄应配暗描边");
  assert.match(contrastOutlineFor(0x000000), /rgba\(255,255,255/, "黑字应配亮描边");
  assert.match(contrastOutlineFor(0x002e72), /rgba\(255,255,255/, "深蓝应配亮描边");
});

test("描边色不透明到足以托底，但也不是纯色块", () => {
  for (const color of [0x000000, 0xffffff, 0x66ccff, 0x222222]) {
    const alpha = Number(/rgba\(\d+,\d+,\d+,([\d.]+)\)/.exec(contrastOutlineFor(color))?.[1]);
    assert.ok(alpha >= 0.7, `alpha ${alpha} 太低，托不住字`);
    assert.ok(alpha <= 0.95, `alpha ${alpha} 太高，会盖住视频画面`);
  }
});

/* ---------------------------------------------------------------- *
 * CSS 解析（本模块不再硬编码背景色，靠它从 DOM 取值）
 * ---------------------------------------------------------------- */

test("parseCssColor 能解析浏览器实际给出的两种格式", () => {
  assert.deepEqual(parseCssColor("rgb(20, 18, 24)"), [20, 18, 24]);
  assert.deepEqual(parseCssColor("rgba(20, 18, 24, 0.5)"), [20, 18, 24]);
  // 浏览器有时不写逗号（更少见但合法）
  assert.deepEqual(parseCssColor("rgb(20 18 24)"), [20, 18, 24]);
});

test("parseCssColor 对解析不出的值返回 null（而不是抛错或猜）", () => {
  // 解析失败必须能被调用方识别 —— 静默返回错误颜色比不处理更糟
  for (const value of ["", "transparent", "color(srgb 0.1 0.2 0.3)", "var(--x)"]) {
    assert.equal(parseCssColor(value), null, `${JSON.stringify(value)} 应返回 null`);
  }
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
    assert.match(toCssColor(color), /^#[0-9a-f]{6}$/);
  }
});

/* ---------------------------------------------------------------- *
 * 真实场景
 * ---------------------------------------------------------------- */

test("本项目实测不可读的那几条颜色都被修正", () => {
  const realCases = [
    { original: 0x002e72, label: "深蓝 1.63:1" },
    { original: 0x222222, label: "深灰 1.32:1" },
    { original: 0x683a7b, label: "紫 2.48:1" },
    { original: 0xc60012, label: "红 4.41:1" },
  ];

  for (const { original, label } of realCases) {
    const result = ensureReadableColor(original, WORST_DARK);
    assert.ok(
      ratio(rgbOf(result.color), WORST_DARK) >= MIN_DANMAKU_CONTRAST,
      `${label}: 调整后仍不达标`,
    );
    assert.ok(result.adjusted, `${label} 应被标记为已调整`);
    assert.equal(
      ratio(rgbOf(original), WORST_DARK) < MIN_DANMAKU_CONTRAST,
      true,
      `${label} 本就不达标，这条用例的前提失效了`,
    );
  }
});

test("contrastRatio 与独立实现一致", () => {
  // 两条实现必须给出同一结果，否则「测试通过」没有意义
  for (const [fg, bg] of [
    [0xffffff, 0x141218],
    [0x000000, 0xfef7ff],
    [0x002e72, 0x1d1b20],
  ] as const) {
    const mine = contrastRatio(rgbOf(fg), rgbOf(bg));
    const theirs = ratio(rgbOf(fg), rgbOf(bg));
    assert.ok(Math.abs(mine - theirs) < 1e-9, `${mine} vs ${theirs}`);
  }
});
