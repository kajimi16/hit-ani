/**
 * 时间表排行榜的数据组装。
 *
 * ## BGM 数据直接取自搜索结果，不需要任何额外请求
 *
 * 一开始我让这个模块去查本地 `Subject` 表取 BGM 人数与评分 —— 结果榜单只
 * 显示出**本周 39 部里的 1 部**，因为只有被打开过的条目才会进缓存。
 * 那是个不可用的设计。
 *
 * 后来核对搜索响应发现：`/v0/search/subjects` 返回的**就是完整的 `Subject`**
 * （不是 `SlimSubject`），里面同时带着 `collection`（doing/wish/collect/
 * on_hold/dropped）与 `rating`（score/rank/total/count）。也就是说这些数据
 * 在搜索那一趟里已经拿到了，本地表根本用不着。
 *
 * 因此：**BGM 侧全部来自入参的搜索结果**，本地库只负责**校内**统计
 * （站内收藏人数与平均分）—— 那是别处拿不到的。
 */

import { prisma } from "@/lib/prisma";
import { CollectionStatus } from "@/lib/collection";
import type { Subject } from "@/lib/bgm/client";
import type { LeaderboardEntry } from "@/lib/schedule-leaderboard";

/**
 * 组装排行榜条目。
 *
 * @param subjects 本周的条目 —— **直接来自搜索响应**，BGM 人数与评分从中取。
 * @param schoolId 本校本校标识，用于站内统计。
 */
export async function buildLeaderboard(input: {
  subjects: Subject[];
  schoolId: string;
}): Promise<LeaderboardEntry[]> {
  const subjectIds = input.subjects.map((subject) => subject.id);
  if (subjectIds.length === 0) return [];

  /*
   * 校内统计用两次 `groupBy` 各取一组结果，而不是把该周几十个条目的收藏行
   * 全部拉回来再在 JS 里数。
   *
   * 两次查询都必须带 `user: { schoolId }` —— 学校维度是本校筛选的根基，
   * 应该在 `where` 里就限定住，而不是取回来再过滤。
   */
  const [schoolDoing, schoolRatings] = await Promise.all([
    prisma.collection.groupBy({
      by: ["subjectId"],
      where: {
        subjectId: { in: subjectIds },
        type: CollectionStatus.Doing,
        user: { schoolId: input.schoolId },
      },
      _count: { _all: true },
    }),
    /*
     * 平均分只统计**有评分**的收藏 —— `rating` 为 null 时不能算进去，
     * 否则未评分的收藏会被当成 0 分，把平均分拉垮。
     */
    prisma.collection.groupBy({
      by: ["subjectId"],
      where: {
        subjectId: { in: subjectIds },
        rating: { not: null },
        user: { schoolId: input.schoolId },
      },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  const doingBySubject = new Map(schoolDoing.map((row) => [row.subjectId, row._count._all]));
  const ratingBySubject = new Map(
    schoolRatings.map((row) => [row.subjectId, { avg: row._avg.rating, count: row._count._all }]),
  );

  return input.subjects.map((subject) => {
    const rating = ratingBySubject.get(subject.id);
    return {
      subjectId: subject.id,
      title: subject.name_cn || subject.name,
      coverUrl: subject.images?.common ?? subject.images?.large ?? null,
      // BGM 侧：来自搜索响应，每个条目都有
      bgmScore: subject.rating?.score ?? null,
      bgmDoing: subject.collection?.doing ?? null,
      // 本站侧
      schoolDoing: doingBySubject.get(subject.id) ?? 0,
      // 保留一位小数，避免界面出现 8.333333
      schoolAvgRating: rating?.avg == null ? null : Math.round(rating.avg * 10) / 10,
      schoolRatedCount: rating?.count ?? 0,
    } satisfies LeaderboardEntry;
  });
}
