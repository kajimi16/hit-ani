/**
 * 首页「推荐 / 热门趋势」的查询构造。
 *
 * ## 为什么是函数，而不是模块级常量
 *
 * 早先这里是一个 `const RECOMMEND_QUERY = {...}`，其中的
 * `air_date: [">=" + recentCutoff()]` 在**模块加载时**求值一次 ——
 * 也就是进程启动那一刻。容器跑得越久，这个「近一年」的下界越旧：
 * 跑满一年，窗口就悄悄变成「近两年」。
 *
 * 这种漂移**不会报错**，只会让首页逐渐混入越来越旧的作品，因此很难被发现。
 * 抽成函数后每次请求都按当前时间重算，并用测试锁住这条语义。
 */

import { SubjectType } from "@/lib/bgm/client";

/**
 * 「近期」的起始日期 —— 取过去一年。
 *
 * 不取当季：当季作品数量太少（一季约 30 部），撑不满首页网格；
 * 一年窗口既有当季也有刚完结的高热作品。
 *
 * `now` 可注入，仅用于测试；生产调用不传。
 */
export function recentCutoff(now: Date = new Date()): string {
  const date = new Date(now.getTime());
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * 首页「热门趋势 / 推荐」共用的查询：近一年的动画，按收藏人数排序。
 *
 * 每页条数与偏移见 `@/lib/bgm/paging`。
 */
export function recommendQuery(now: Date = new Date()) {
  return {
    keyword: "",
    sort: "heat" as const,
    filter: {
      type: [SubjectType.Anime] as never,
      air_date: [`>=${recentCutoff(now)}`],
      nsfw: false,
    },
  };
}
