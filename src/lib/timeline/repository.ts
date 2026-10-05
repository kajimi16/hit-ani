/**
 * 时光机的数据查询。
 *
 * 与归一化（`types.ts` 的纯函数）分开，因为这里的每一处 `where` 都带着
 * **隐私约束**，需要能被单独审阅。
 */

import { prisma } from "@/lib/prisma";
import { buildTimeline, TIMELINE_INCLUDES, type TimelineEvent } from "./types";

/** 一次查询每类活动最多取多少条。四类各取这么多，再合并排序后截断。 */
const PER_SOURCE_LIMIT = 60;

export interface TimelineOptions {
  /**
   * 只看某个 BGM 账号的收藏（BGM 时光机）。
   *
   * 与 `schoolId` 互斥使用：BGM 时光机看的是「一个人在他自己 BGM 账号上的
   * 活动」，校内时光机看的是「同一所学校里所有人在本站的活动」。
   */
  bgmUsername?: string;
  /** 只看某所学校（校内时光机）。 */
  schoolId?: string;
  /** 最终返回的条数上限。 */
  limit?: number;
  /**
   * 只取**来自 Bangumi 的活动**（收藏）。
   *
   * BGM 时光机必须开这个开关，否则会把本站的弹幕/进度也混进来 ——
   * 那是在**本站**发生的行为，与「你在 Bangumi 上的活动」不是一回事。
   * 只有收藏带 `collectedAt`（来自上游的 `updated_at`），是唯一真正反映
   * BGM 侧动作的数据。
   */
  bgmOnly?: boolean;
}

/**
 * 构造时光机事件流。
 *
 * ## 隐私约束（每一处都写明理由）
 *
 * - **私密收藏一律排除**（`isPrivate: false`）。BGM 上标记为私密的收藏是用户
 *   明确表示不想被看到的内容，替他在别人面前展示就是泄露。
 * - **只看同校**（`schoolId`）。校内时光机的定位就是「校内用户的时光机」，
 *   不该混入校外账号的活动。
 * - **弹幕只看 `status` 正常的**（0 = 正常）。被屏蔽/删除的弹幕不该继续在
 *   时光机里出现（那会绕过内容治理）。
 * - **取的是「行」不是「人」**：即使某人把收藏设为私密，他的评论与弹幕仍会
 *   出现在时光机里 —— 那是他在本站公开发布的内容，与收藏的隐私设置无关。
 */
export async function queryTimeline(options: TimelineOptions): Promise<TimelineEvent[]> {
  const limit = options.limit ?? 60;

  /**
   * 由「BGM 账号」或「学校」解析出要包含的 userId 列表。
   *
   * 用一次 `user.findMany` 拿到 id，而不是在四个查询里各写一遍嵌套
   * `where` —— 后者会让「哪些用户该被包含」这条规则分散到四处，改一处漏三处。
   */
  const users = await prisma.user.findMany({
    where: options.bgmUsername
      ? { bgmBinding: { bgmUsername: options.bgmUsername } }
      : options.schoolId
        ? { schoolId: options.schoolId }
        : {},
    select: { id: true },
    take: 500,
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length === 0) return [];

  const userFilter = { userId: { in: userIds } };

  /*
   * `bgmOnly` 时只查收藏，其余三类直接给空数组 —— 不是「查了再过滤」，
   * 而是根本不发那三条查询（省掉三次无用的数据库往返）。
   */
  const skip = options.bgmOnly === true;

  const [collections, reviews, danmakus, progress] = await Promise.all([
    prisma.collection.findMany({
      // 私密收藏排除 —— 见上方隐私约束
      where: { ...userFilter, isPrivate: false },
      /*
       * `nulls: "last"` 是必需的，不是修饰。
       *
       * Postgres 的 `ORDER BY ... DESC` **默认把 NULL 排在最前** ——
       * 于是所有「不知道加入时间」的收藏会顶掉全部有时效的活动，
       * 时光机首页因此被一批无时间的条目占满。
       * （追番页的排序踩过同一个坑，这里第一版又漏了。）
       */
      orderBy: [{ collectedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: PER_SOURCE_LIMIT,
      include: TIMELINE_INCLUDES.collection,
    }),
    skip ? Promise.resolve([]) : prisma.review.findMany({
      where: userFilter,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: PER_SOURCE_LIMIT,
      include: TIMELINE_INCLUDES.review,
    }),
    skip ? Promise.resolve([]) : prisma.danmaku.findMany({
      // 只取正常状态的弹幕 —— 被屏蔽/删除的不该在时光机里复现
      where: { ...userFilter, status: 0 },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: PER_SOURCE_LIMIT,
      include: TIMELINE_INCLUDES.danmaku,
    }),
    skip ? Promise.resolve([]) : prisma.episodeProgress.findMany({
      where: userFilter,
      orderBy: [{ updatedAt: "desc" }],
      take: PER_SOURCE_LIMIT,
      include: TIMELINE_INCLUDES.progress,
    }),
  ]);

  // `EpisodeProgress` 没有独立主键以外的时间精度问题，但它是唯一没有 `id`
  // 参与排序的来源 —— 归一化里统一用 `id` 收尾保证稳定。
  return buildTimeline({ collections, reviews, danmakus, progress }).slice(0, limit);
}
