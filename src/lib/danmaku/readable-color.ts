/**
 * 弹幕颜色的可读性处理。
 *
 * ## 问题
 *
 * 弹幕颜色由**发送者**指定（`Danmaku.color`），而我们的界面是深色的。
 * 于是实测：2000 条弹幕里 **339 条（17%）不可读** ——
 * `rgb(0,46,114)` 深蓝在白底上好看，在深色画布上只有 **1.63:1**；
 * `rgb(34,34,34)` 深灰更是 **1.32:1**，等于隐形。
 *
 * 这不是"某个颜色没选好"，而是**深色主题 + 用户自定义颜色**的必然冲突：
 * 发送者是在浅色播放器（B 站/弹弹play）里挑的颜色。
 *
 * ## 取舍：保留色相，只提亮度
 *
 * 三种做法：
 *
 * | 做法 | 问题 |
 * | --- | --- |
 * | 禁用颜色，全部用白 | 丢失弹幕文化的一部分（颜色本身有表达力） |
 * | 原样显示 | 17% 不可读 |
 * | **按背景提亮到可读** | 保留色相与色相差异，只补偿亮度 ← 采用 |
 *
 * 具体做法：在保持 RGB 比例（色相与饱和度关系）的前提下，按比例放大到
 * 满足最小对比度。纯黑（0,0,0）没有比例可言，此时回退为白色。
 *
 * 提亮有上限：超过阈值仍不达标就放弃保留色相，直接用白色 ——
 * 一条读不出来的彩色弹幕，不如一条能读出来的白弹幕。
 */

/** 弹幕在页面上显示的最小对比度。与 `tests/contrast.test.ts` 同一阈值。 */
export const MIN_DANMAKU_CONTRAST = 4.5;

/** 深色画布与卡片的背景色（与 `globals.css` 的 token 一致）。 */
const DARK_BACKDROPS = [
  [10, 11, 15],
  [18, 21, 29],
  [25, 29, 39],
  [33, 38, 48],
] as const;

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance([r, g, b]: readonly number[]): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * 弹幕文本要满足的对比度基准。
 *
 * 取**最暗的**那个深色背景来算 —— 只要在最不利的背景上可读，
 * 在其它背景上只会更清楚。这样只需算一次、也不用在渲染时关心实际背景。
 */
const WORST_BACKDROP = DARK_BACKDROPS.reduce((worst, current) =>
  relativeLuminance(current) > relativeLuminance(worst) ? current : worst,
);

const WORST_BACKDROP_LUMINANCE = relativeLuminance(WORST_BACKDROP);

/**
 * 目标亮度：由对比度公式反解。
 *
 * `(L_fg + 0.05) / (L_bg + 0.05) >= ratio`
 *   → `L_fg >= ratio * (L_bg + 0.05) - 0.05`
 */
const TARGET_LUMINANCE =
  MIN_DANMAKU_CONTRAST * (WORST_BACKDROP_LUMINANCE + 0.05) - 0.05;

/** 线性分量 → sRGB 分量。 */
function linearToSrgb(value: number): number {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export interface ReadableColor {
  /** 调整后的 RGB 整数（0xRRGGBB） */
  color: number;
  /** 是否做过调整 —— 供调试与统计 */
  adjusted: boolean;
}

/**
 * 把弹幕颜色调整到在深色背景上可读。
 *
 * 算法：二分搜索一个缩放系数 `k`，把每个分量向 255 方向推
 * （`c' = c + (255 - c) * k`）—— 这样**保留分量间的相对关系**，
 * 色相基本不变，而亮度单调上升。
 *
 * 用"向 255 推"而非"整体乘以 k"：后者在暗色上放大倍数极大，
 * 会把深蓝推成品红；前者对暗色更温和。
 *
 * 到达 k=1（纯白）仍不达标时返回白色 —— 可读性优先于色相。
 */
export function readableDanmakuColor(color: number): ReadableColor {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;

  const original: [number, number, number] = [r, g, b];
  if (relativeLuminance(original) >= TARGET_LUMINANCE) {
    return { color: color & 0xffffff, adjusted: false };
  }

  let low = 0;
  let high = 1;
  // 20 次足够收敛到 1/255 以内（2^-20 ≈ 1e-6），远高于 8 位精度需求
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    const candidate: [number, number, number] = [
      r + (255 - r) * mid,
      g + (255 - g) * mid,
      b + (255 - b) * mid,
    ];
    if (relativeLuminance(candidate) >= TARGET_LUMINANCE) high = mid;
    else low = mid;
  }

  const lifted: [number, number, number] = [
    linearToSrgb(srgbToLinear(r + (255 - r) * high)),
    linearToSrgb(srgbToLinear(g + (255 - g) * high)),
    linearToSrgb(srgbToLinear(b + (255 - b) * high)),
  ];

  // 极端情况（纯黑、极暗色）：提亮后仍有色偏却不达标，直接用白色兜底
  if (relativeLuminance(lifted) < TARGET_LUMINANCE) {
    return { color: 0xffffff, adjusted: true };
  }

  return {
    color: (lifted[0] << 16) | (lifted[1] << 8) | lifted[2],
    adjusted: true,
  };
}

/** 便捷：直接取调整后的 RGB 整数。 */
export function ensureReadableColor(color: number): number {
  return readableDanmakuColor(color).color;
}

/** 调整后是否与原始颜色不同 —— 用于统计"有多少弹幕被提亮"。 */
export function isAdjusted(color: number): boolean {
  return readableDanmakuColor(color).adjusted;
}

/**
 * RGB 整数 → CSS 颜色字符串。
 *
 * 存在的理由：`(`#${color.toString(16)}`)` 这种写法**会漏掉前导零** ——
 * `0x0000ff` 渲染成 `#ff`，浏览器解析为无效值，弹幕变成继承色（而非蓝色）。
 * 弹幕颜色是 24 位整数，暗色恰恰前导零最多，所以这个 bug 专门影响暗色弹幕。
 */
export function toCssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}
