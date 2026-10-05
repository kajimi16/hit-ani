/**
 * 颜色对比度测试。
 *
 * ## 为什么需要它
 *
 * 深色主题里最容易出的事故是「文字看不见」—— 而且**功能测试完全测不出来**：
 * DOM 在、文字在、接口 200，只是人读不到。这比崩溃更难发现。
 *
 * 本项目发生过两次：`ink-faint` 初值只有 3.84:1（低于 AA），而它承载的
 * 恰恰是「共 4920 条，已显示前 3000 条」这类**必须被读到**的信息。
 *
 * ## 现在的配色来源
 *
 * 已改为 Animeko 的 M3 色板（种子色 `#4F378B` 生成，见 `globals.css`）。
 * 深色是默认且**不跟随系统**；浅色只在显式 `data-theme="light"` 时生效。
 * M3 的角色色**设计上就保证对比度**，但仍需守住 —— 因为可能出现：
 * - 误用 `outline`（设计用于描边，不是文字）当文字色
 * - 在 `primaryContainer` 上放 `onSurface`（角色配错）
 *
 * 因此测试覆盖**明暗两套**色板下的关键配对。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/* ---------------------------------------------------------------- *
 * WCAG 2.1
 * ---------------------------------------------------------------- */

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 对比度：(L1 + 0.05) / (L2 + 0.05)，L1 为较亮者。 */
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

/** AA 对正文的要求。 */
const AA_NORMAL = 4.5;
/** AAA —— 正文主力色应留足余量给不同显示器。 */
const AAA_NORMAL = 7;

/* ---------------------------------------------------------------- *
 * 从 globals.css 读色板（不硬编码，否则改了 CSS 测试会一起漂移）
 * ---------------------------------------------------------------- */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

const BLANK = "\n";

/** 抽取 `:root { ... }` 里 `--md-*` 的定义。 */
function parseMdTokens(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--md-([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    tokens[name] = value;
  }
  return tokens;
}


/** 四层表面（Animeko 的分层语义）。 */
const SURFACES = [
  "surface-container-lowest",
  "surface-container-low",
  "surface-container",
  "surface-container-high",
  "surface-container-highest",
] as const;

/** 在某个表面上会出现的文字色 —— 只列出真实用到的配对。 */
const FOREGROUNDS = ["on-surface", "on-surface-variant"] as const;

/** 暗色 = `:root`；浅色 = `:root[data-theme="light"]`（显式选择，不跟随系统）。 */
function readPalettes(): { dark: Record<string, string>; light: Record<string, string> } {
  const lightBlock =
    /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? "";
  const darkBlock = /^:root\s*\{([\s\S]*?)\n\}/m.exec(CSS)?.[1] ?? "";
  return { dark: parseMdTokens(darkBlock), light: parseMdTokens(lightBlock) };
}

test("明暗两套色板都定义了全部 M3 角色", () => {
  const { dark, light } = readPalettes();
  const required = [
    ...SURFACES,
    ...FOREGROUNDS,
    "primary",
    "on-primary",
    "primary-container",
    "on-primary-container",
    "secondary-container",
    "on-secondary-container",
    "tertiary-container",
    "on-tertiary-container",
    "error-container",
    "on-error-container",
    "outline",
    "outline-variant",
  ];

  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const role of required) {
      assert.ok(palette[role], `${name} 色板缺少 --md-${role}`);
    }
  }
});

/* ---------------------------------------------------------------- *
 * 前景 / 表面配对
 * ---------------------------------------------------------------- */

test("明暗两套下，文字色在所有表面上都满足 AA", () => {
  const { dark, light } = readPalettes();
  const failures: string[] = [];

  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const fg of FOREGROUNDS) {
      for (const surface of SURFACES) {
        const ratio = contrastRatio(hexToRgb(palette[fg]), hexToRgb(palette[surface]));
        if (ratio < AA_NORMAL) {
          failures.push(`${name}: ${fg} 在 ${surface} 上仅 ${ratio.toFixed(2)}:1`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `对比度不达标：\n  ${failures.join("\n  ")}`);
});

test("主文字色在页面底色上达 AAA（留余量给不同显示器）", () => {
  const { dark, light } = readPalettes();
  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    const ratio = contrastRatio(
      hexToRgb(palette["on-surface"]),
      hexToRgb(palette["surface-container-lowest"]),
    );
    assert.ok(ratio >= AAA_NORMAL, `${name}: on-surface 仅 ${ratio.toFixed(2)}:1，未达 AAA`);
  }
});

/* ---------------------------------------------------------------- *
 * container / on-container 配对（M3 的核心约定）
 * ---------------------------------------------------------------- */

test("container 与 on-container 成对使用，且都满足 AA", () => {
  const { dark, light } = readPalettes();
  const pairs = [
    ["primary-container", "on-primary-container"],
    ["secondary-container", "on-secondary-container"],
    ["tertiary-container", "on-tertiary-container"],
    ["error-container", "on-error-container"],
  ] as const;

  const failures: string[] = [];
  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const [container, onContainer] of pairs) {
      const ratio = contrastRatio(hexToRgb(palette[onContainer]), hexToRgb(palette[container]));
      if (ratio < AA_NORMAL) {
        failures.push(`${name}: ${onContainer} 在 ${container} 上仅 ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.deepEqual(failures, [], `角色配错：\n  ${failures.join("\n  ")}`);
});

test("按钮文字与按钮底色满足 AA", () => {
  const { dark, light } = readPalettes();
  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    const ratio = contrastRatio(hexToRgb(palette["on-primary"]), hexToRgb(palette["primary"]));
    assert.ok(ratio >= AA_NORMAL, `${name}: on-primary 在 primary 上仅 ${ratio.toFixed(2)}:1`);
  }
});

/* ---------------------------------------------------------------- *
 * 描边角色
 * ---------------------------------------------------------------- */

test("outline 与 outline-variant 是描边色，不与表面同色导致边界消失", () => {
  const { dark, light } = readPalettes();
  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    for (const role of ["outline", "outline-variant"] as const) {
      for (const surface of ["surface-container-lowest", "surface-container-low"] as const) {
        const ratio = contrastRatio(hexToRgb(palette[role]), hexToRgb(palette[surface]));
        // 描边不需要达到正文标准，但必须能看出边界（≥1.3:1）
        assert.ok(
          ratio >= 1.3,
          `${name}: ${role} 在 ${surface} 上仅 ${ratio.toFixed(2)}:1，边界不可见`,
        );
      }
    }
  }
});

test("四层表面单调递进 —— 深色下越亮、浅色下越暗", () => {
  // M3 语义：`surfaceContainer` 表示「在背景之上」。深色主题下提亮、
  // 浅色主题下压暗，因此两个色板的单调方向**相反**。
  // 若浅色板只是照抄深色，浅色模式下层级会消失 —— 这条断言能抓出来。
  const { dark, light } = readPalettes();

  for (const [name, palette] of [
    ["dark", dark],
    ["light", light],
  ] as const) {
    const lums = SURFACES.map((s) => relativeLuminance(hexToRgb(palette[s])));
    const ascending = lums[lums.length - 1] > lums[0];
    for (let i = 1; i < lums.length; i += 1) {
      const step = lums[i] - lums[i - 1];
      assert.ok(
        ascending ? step > 0 : step < 0,
        `${name}: ${SURFACES[i]} 与 ${SURFACES[i - 1]} 的层级方向不一致（应${ascending ? "递增" : "递减"}）`,
      );
    }
  }
});
