/**
 * 评分直方图的归一化。
 *
 * BGM 把 1–10 分的评分人数放在 `rating.count` 里，形如
 * `{"1": 21, "7": 921, "8": 2708, "9": 3111, "10": 982}`。
 *
 * 它是**不可信输入**（外部 JSON、且我们会把它整个存进 Json 列再读回来），
 * 因此这里既做归一化也做校验：任何非有限数、负数都按 0 处理，缺失的分数
 * 补 0。渲染层拿到的一定是「恰好 10 个非负数」。
 */

export interface HistogramBar {
  /** 分数 1–10 */
  score: number;
  count: number;
  /** 相对最大值的百分比（0–100），用于柱高 */
  percent: number;
}

/** 分数区间：BGM 是 1–10。 */
const MIN_SCORE = 1;
const MAX_SCORE = 10;

/**
 * 把原始直方图转成 10 根柱子。
 *
 * 百分比按**最大值**归一（与 Animeko 的 `RatingHistogram` 一致），
 * 而不是按总数 —— 按总数会让 10 分那根永远只有两三成高，看不出分布形状。
 */
export function histogramBars(raw: unknown): HistogramBar[] {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  const counts: number[] = [];
  for (let score = MIN_SCORE; score <= MAX_SCORE; score += 1) {
    const value = (source as Record<string, unknown>)[String(score)];
    counts.push(typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  }

  const max = Math.max(...counts, 0);
  return counts.map((count, index) => ({
    score: index + MIN_SCORE,
    count,
    // 有数据但极小时也留一点可见高度（Animeko 的最低可见比例是 6%）；
    // 真的为 0 就是 0，不该画出一根不存在的柱子。
    percent: count === 0 || max === 0 ? 0 : Math.max(6, (count / max) * 100),
  }));
}

/** 直方图里是否有任何数据 —— 没有就不显示这个板块。 */
export function hasHistogramData(bars: HistogramBar[]): boolean {
  return bars.some((bar) => bar.count > 0);
}
