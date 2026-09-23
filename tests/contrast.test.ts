/**
 * 颜色对比度测试。
 *
 * ## 为什么需要它
 *
 * 深色主题里最容易出的事故是「文字看不见」—— 而且**功能测试完全测不出来**：
 * DOM 在、文字在、接口 200，只是人读不到。这比崩溃更难发现。
 *
 * 本项目就发生过：`ink-faint` 初值 `#6a7387` 在卡片上只有 **3.84:1**，
 * 低于 WCAG AA 的 4.5:1，而它承载的恰恰是「共 4920 条，已显示前 3000 条」
 * 这类**必须被读到**的信息 —— 加这条提示的用意就是消除误解，
 * 结果它几乎读不出来，目的落空。而且它大量用在 `text-xs` 上，实际更糟。
 *
 * 因此用测试把对比度钉住：改色时若跌破 AA，测试会失败。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/* ---------------------------------------------------------------- *
 * WCAG 2.1 相对亮度与对比度
 * ---------------------------------------------------------------- */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return (
    0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
  );
}

/** WCAG 对比度公式：(L1 + 0.05) / (L2 + 0.05)，L1 为较亮者。 */
export function contrastRatio(
  fg: [number, number, number],
  bg: [number, number, number],
): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/**
 * 从 `globals.css` 读 token —— **不硬编码**。
 *
 * 硬编码的话，改了 CSS 而忘改测试，两者会一起漂移，测试就失去意义。
 * 从真实来源读取才能守住这条线。
 */
function readTokens(): Record<string, string> {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[name] = value;
  }
  return tokens;
}

/** AA 对正文的要求。 */
const AA_NORMAL = 4.5;
/** 所有作为背景使用的表面色。 */
const SURFACES = ["canvas", "surface", "surface-2", "surface-3"] as const;
/** 所有用于文字的颜色。 */
const INKS = ["ink", "ink-muted", "ink-faint"] as const;

/* ---------------------------------------------------------------- *
 * token 存在性
 * ---------------------------------------------------------------- */

test("globals.css 里定义了必需的颜色 token", () => {
  const tokens = readTokens();
  for (const name of [...INKS, ...SURFACES]) {
    assert.ok(tokens[name], `缺少 token --color-${name}`);
  }
});

/* ---------------------------------------------------------------- *
 * 对比度
 * ---------------------------------------------------------------- */

test("三级文字色在每一种表面色上都满足 WCAG AA（4.5:1）", () => {
  const tokens = readTokens();
  const failures: string[] = [];

  for (const ink of INKS) {
    for (const surface of SURFACES) {
      const ratio = contrastRatio(hexToRgb(tokens[ink]), hexToRgb(tokens[surface]));
      if (ratio < AA_NORMAL) {
        failures.push(
          `${ink} 在 ${surface} 上仅 ${ratio.toFixed(2)}:1（要求 ≥ ${AA_NORMAL}）`,
        );
      }
    }
  }

  assert.deepEqual(failures, [], `对比度不达标：\n  ${failures.join("\n  ")}`);
});

test("最深的三级层次也达标 —— ink-faint 不是「装饰性」颜色", () => {
  // ink-faint 承载的是「共 N 条，已显示前 M 条」这类信息，
  // 不是可有可无的装饰。因此它必须过 AA，而不是走「装饰文字可放宽」的口子。
  const tokens = readTokens();
  const worst = Math.min(
    ...SURFACES.map((s) => contrastRatio(hexToRgb(tokens["ink-faint"]), hexToRgb(tokens[s]))),
  );
  assert.ok(
    worst >= AA_NORMAL,
    `ink-faint 最差对比度 ${worst.toFixed(2)}:1，低于 AA 的 ${AA_NORMAL}`,
  );
});

test("三级之间有明确区分（不是名义上的三级）", () => {
  // 若把 ink-faint 提到与 ink-muted 同值，对比度测试仍会通过，
  // 但层次就没了 —— 那等于把三级压成两级，信息层级丢失。
  const tokens = readTokens();
  const lum = (name: string) => relativeLuminance(hexToRgb(tokens[name]));

  const inkToMuted = lum("ink") / lum("ink-muted");
  const mutedToFaint = lum("ink-muted") / lum("ink-faint");

  assert.ok(inkToMuted > 1.5, `ink 与 ink-muted 亮度比仅 ${inkToMuted.toFixed(2)}，区分不足`);
  assert.ok(
    mutedToFaint > 1.15,
    `ink-muted 与 ink-faint 亮度比仅 ${mutedToFaint.toFixed(2)}，几乎无法区分`,
  );
});

test("表面色由深到浅递进（背景层次成立）", () => {
  const tokens = readTokens();
  const lums = SURFACES.map((s) => relativeLuminance(hexToRgb(tokens[s])));
  for (let i = 1; i < lums.length; i += 1) {
    assert.ok(
      lums[i] > lums[i - 1],
      `${SURFACES[i]} 应比 ${SURFACES[i - 1]} 亮（当前 ${lums[i].toFixed(4)} vs ${lums[i - 1].toFixed(4)}）`,
    );
  }
});

test("正文色在画布上远超 AAA（留足余量给不同显示器）", () => {
  // ink 是主力文字色。只满足 AA（4.5）在低质量屏幕上仍可能吃力，
  // 因此要求它达到 AAA（7:1）以上。
  const tokens = readTokens();
  const ratio = contrastRatio(hexToRgb(tokens["ink"]), hexToRgb(tokens["canvas"]));
  assert.ok(ratio >= 7, `ink 在 canvas 上仅 ${ratio.toFixed(2)}:1，未达 AAA`);
});

test("语义色在画布上满足 AA 大字号阈值（用于徽标与提示）", () => {
  // success / warn / danger 常用在 text-xs 的徽标与提示条上。
  // 这些颜色由设计 token 直接给出（非纯黑/纯白），因此需要单独校验。
  const tokens = readTokens();
  const canvas = hexToRgb(tokens["canvas"]);
  for (const name of ["success", "warn", "danger"] as const) {
    const ratio = contrastRatio(hexToRgb(tokens[name]), canvas);
    assert.ok(
      ratio >= 4.5,
      `${name} 在 canvas 上仅 ${ratio.toFixed(2)}:1，低于 AA 正文阈值`,
    );
  }
});
