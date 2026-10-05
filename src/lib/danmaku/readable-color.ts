/**
 * 弹幕颜色的可读性处理。
 *
 * ## 问题
 *
 * 弹幕颜色由**发送者**指定（`Danmaku.color`），而它们是在浅色播放器
 * （B站/弹弹play）里挑的。在深色背景上实测：2000 条里 **339 条（17%）不可读**
 * —— `rgb(0,46,114)` 深蓝只有 1.63:1，`rgb(34,34,34)` 深灰 1.32:1。
 *
 * ## 取舍：保留色相，只调亮度
 *
 * | 做法 | 问题 |
 * | --- | --- |
 * | 禁用颜色，全部用白 | 丢失弹幕文化的一部分 |
 * | 原样显示 | 17% 不可读 |
 * | **按背景调到可读** | 保留色相差异，只补偿亮度 ← 采用 |
 *
 * ## ⚠️ 背景色是**参数**，不是常量
 *
 * 早先这里硬编码了四个深色 RGB 三元组，注释写「与 globals.css 一致」——
 * 但**没有任何东西强制这条一致性**。换主题（本项目后来对齐了 Animeko 的
 * M3 色板）后数组随即过期，而后果是静默的：
 *
 * - `readableDanmakuColor` 用其中最亮的那个反解目标亮度，新表面更亮时
 *   弹幕会**提亮不足**；
 * - 而这个模块的单测是拿同一份硬编码数组自测的，**照样全绿**；
 * - `contrast.test.ts` 只管 `on-surface` 对 `surface`，不覆盖弹幕色。
 *
 * 即「不变量重复定义且无测试关联」。现在改为**由调用方传入真实背景色**，
 * 从根上消除重复。
 *
 * ## 两种主题都要处理
 *
 * 深色下要**提亮**、浅色下要**压暗** —— 一律提亮在浅色主题上会让弹幕消失。
 */

/** 弹幕显示的最小对比度。与 `tests/contrast.test.ts` 同一阈值。 */
export const MIN_DANMAKU_CONTRAST = 4.5;

/** RGB 三元组。 */
export type Rgb = readonly [number, number, number];

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 相对亮度。 */
export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 对比度。 */
export function contrastRatio(fg: Rgb, bg: Rgb): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

export function rgbOf(color: number): Rgb {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

export function packRgb([r, g, b]: Rgb): number {
  return (r << 16) | (g << 8) | b;
}

/**
 * 解析 CSS 颜色字符串为 RGB。
 *
 * 用于从真实 DOM 读背景色 —— 这样背景由 CSS 单一来源决定，
 * 本模块不再复制色值。
 */
export function parseCssColor(value: string): Rgb | null {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface ReadableColor {
  color: number;
  adjusted: boolean;
}

/**
 * 把弹幕颜色调到在给定背景上可读。
 *
 * 算法：二分搜索最小的缩放系数 `k`，按背景把各分量**向黑或向白推**
 * （`c' = c + (target - c) * k`）—— 保留分量间的相对关系（色相基本不变），
 * 亮度单调变化。
 *
 * 用「推向极值」而非「整体乘以 k」：后者在暗色上放大倍数极大，
 * 会把深蓝推成品红。
 */
export function ensureReadableColor(color: number, backdrop: Rgb): ReadableColor {
  const rgb = rgbOf(color);
  if (contrastRatio(rgb, backdrop) >= MIN_DANMAKU_CONTRAST) {
    return { color: color & 0xffffff, adjusted: false };
  }

  /*
   * 目标是**对比度更高**的那个极值。
   *
   * 不能按「背景亮度 < 0.5 就提亮」判断：中灰背景（如 `#7f7f7f`，亮度 0.216）
   * 上白色只有 3.95:1 —— 此时该压暗而不是提亮。
   * 白色与中灰背景的对比度交叉点在背景亮度 0.179，与 0.5 相差很远。
   */
  const target =
    contrastRatio([255, 255, 255], backdrop) >= contrastRatio([0, 0, 0], backdrop) ? 255 : 0;

  /**
   * 按系数取值并**取整到 8 位**。
   *
   * 必须用取整后的颜色判定：函数返回的就是整数通道，若按未取整的值判定，
   * 返回值可能因四舍五入掉回阈值以下 —— 实测 `#683a7b` 在 `#36343b` 上
   * 因此被误判为「无解」而直接洗成纯白，丢掉了色相。
   */
  const scaled = (k: number): Rgb => [
    Math.round(rgb[0] + (target - rgb[0]) * k),
    Math.round(rgb[1] + (target - rgb[1]) * k),
    Math.round(rgb[2] + (target - rgb[2]) * k),
  ];

  let low = 0;
  let high = 1;
  // 20 次足够收敛到 1/255 以内（2^-20 ≈ 1e-6），远高于 8 位精度需求
  for (let i = 0; i < 20; i += 1) {
    const mid = (low + high) / 2;
    if (contrastRatio(scaled(mid), backdrop) >= MIN_DANMAKU_CONTRAST) high = mid;
    else low = mid;
  }

  /*
   * 不需要「连极值都不达标」的兜底分支：白色与黑色的对比度中，
   * 较大者恒 ≥ √(1.05/0.05) ≈ 4.58 > 4.5 —— 因为两者的对比度之积恒为
   * (1.05/(L+0.05)) · ((L+0.05)/0.05) = 21，两个正数之积固定时最大值
   * 至少为 √21。因此 k = 1 一定可接受，二分收敛到的 `high` 也一定可接受。
   */
  return { color: packRgb(scaled(high)), adjusted: true };
}


/**
 * 画布（canvas）上弹幕的**描边色**。
 *
 * canvas 的背景是**视频画面**，亮度不可知 —— 因此不能用
 * `ensureReadableColor`（那需要已知背景，且改掉颜色会违背发送者的选择，
 * 有些人特意针对亮画面选了深色）。
 *
 * 正确做法是描边与字色**亮度相反**：亮字配暗描边、暗字配亮描边。
 * 这对任意视频背景都成立，且保留原色。
 */
export function contrastOutlineFor(color: number): string {
  // 阈值取 0.35：偏低的字色在多数亮画面上仍需要白描边托底
  return relativeLuminance(rgbOf(color)) > 0.35
    ? "rgba(0,0,0,0.85)"
    : "rgba(255,255,255,0.85)";
}

/**
 * RGB 整数 → CSS 颜色字符串。
 *
 * 存在的理由：`` `#${color.toString(16)}` `` 这种写法**会漏掉前导零** ——
 * `0x0000ff` 渲染成 `#ff`，浏览器解析为无效值，弹幕变成继承色（而非蓝色）。
 * 弹幕颜色是 24 位整数，暗色恰恰前导零最多，所以这个 bug 专门影响暗色弹幕。
 */
export function toCssColor(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
}
