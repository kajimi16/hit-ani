/**
 * 评分变更的确认文案。
 *
 * ## 为什么需要二次确认
 *
 * 评分是**一排 10 个紧挨着的数字按钮** —— 在触屏上极易点错相邻的一格，
 * 而评分会立即写库（绑定 BGM 时还会镜像到用户的真实账号，见
 * `mirror-guard.ts`）。用户明确要求「修改评分和评论时需要手动二次确认」。
 *
 * ## 为什么文案要单独算
 *
 * 确认框只说「确定吗？」没有意义 —— 用户需要知道**这次点击会改变什么**：
 * - 从 6 分改成 9 分（改了什么）
 * - 取消评分（是删除，不是改成 0）
 * - **还未收藏时会顺带创建一个「在看」收藏**（最容易被忽略的副作用）
 *
 * 抽成纯函数是为了能直接测这些分支 —— 文案错漏的后果是用户确认了一件
 * 他没同意的事。
 */

import { CollectionStatus, statusLabel } from "@/lib/collection";

export interface RatingChange {
  /** 点击后是否已收藏（用于界面提示「需要先收藏」）。 */
  createsCollection: boolean;
  /** 一句话主文案。 */
  title: string;
  /** 补充说明；无需补充时为 null。 */
  detail: string | null;
}

/**
 * 计算二次确认要显示的内容。
 *
 * @param current  当前评分（1–10），未评为 null
 * @param next     本次要设置的评分（1–10），清除时为 null
 * @param status   当前收藏状态值；null 表示尚未收藏
 */
export function describeRatingChange(
  current: number | null,
  next: number | null,
  status: number | null,
): RatingChange {
  const createsCollection = status === null;

  const title =
    next === null
      ? current === null
        ? "清除评分？"
        : `取消 ${current} 分的评分？`
      : current === null
        ? `给它打 ${next} 分？`
        : current === next
          ? `取消 ${current} 分的评分？`
          : `把评分从 ${current} 分改为 ${next} 分？`;

  /*
   * 副作用要明说。
   *
   * 评分是 `Collection` 的属性 —— 未收藏时**设置**评分会顺带创建一条收藏。
   * 不说清楚的话，用户以为只是打了个分，实际在追番列表里多了一条「在看」，
   * 而且（绑定 BGM 时）会镜像到他的真实账号。
   *
   * 条件必须含 `next !== null`：**取消评分不创建任何东西**，此时还提示
   * 「会标记为在看」是错的。（该组合从界面走不到 —— 没有评分就点不出
   * 「取消」—— 但函数被复用时它是个实打实的错误提示。）
   */
  const detail =
    createsCollection && next !== null
      ? `它还没有在你的追番里，这一下会同时把它标记为「${statusLabel(CollectionStatus.Doing)}」。`
      : null;

  return { createsCollection, title, detail };
}
