/**
 * 追番列表的取数。
 *
 * `/library`（自己的）与 `/users/[id]`（别人的，只读）共用这一份 ——
 * 两处各写一遍必然漂移，而**漂移的后果是隐私失效**：别人的私密收藏会漏出来。
 *
 * ## 两条路径（与「全量加载导致卡顿」那次修复一致）
 *
 * - **聚焦单一状态**：一次查询，按页取。
 * - **全部**：每组各查一次，每组只取前 N 条。
 *
 * 「全部」不能写成「一次取 60 行再按组切分」—— 排序是全局的，前 60 行很可能
 * 全落在同一个状态里，另外四组显示为空（实测过）。
 */

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { COLLECTION_STATUSES, statusLabel, type CollectionStatusValue } from "@/lib/collection";
import {
  LIBRARY_GROUP_PREVIEW,
  LIBRARY_PAGE_SIZE,
  type LibraryQuery,
} from "@/lib/library-query";
import { shouldHidePrivate } from "@/lib/friends/repository";
import { collectionOrderBy } from "@/lib/library-sort";
import type { LibraryItem } from "@/components/library-views";

/** 列表项所需的最小字段集（只要计数，不要把 episode 行传进 RSC 载荷）。 */
const INCLUDE = {
  subject: {
    select: {
      id: true,
      name: true,
      nameCn: true,
      coverUrl: true,
      score: true,
      rank: true,
      _count: { select: { episodes: true } },
    },
  },
} as const;

/**
 * 追番列表里的一行。
 *
 * 用具名类型而不是 `ReturnType<typeof ...>` —— 后者把契约藏在实现旁边，
 * 消费方会耦合到实现函数的名字。
 */
export type LibraryRow = Prisma.CollectionGetPayload<{ include: typeof INCLUDE }>;

export interface LoadLibraryOptions {
  /** 追番归属者。 */
  userId: string;
  /**
   * 访客 id；`null` 表示未登录。
   *
   * **隐私判据**：`viewerId !== userId` 时只返回公开收藏。
   * `Collection.isPrivate` 是用户在 Bangumi 上明确设为私密的内容 ——
   * 给访问者看就是泄露。这条规则与时光机、收藏短评完全一致。
   */
  viewerId: string | null;
  focused: { value: CollectionStatusValue } | null;
  query: LibraryQuery;
}

export interface LibraryData {
  rowsByType: Map<CollectionStatusValue, LibraryRow[]>;
  countByType: Map<number, number>;
  watchedBySubject: Map<number, number>;
  totalForFocused: number;
  /** 本次是否过滤掉了私密收藏（界面可据此说明）。 */
  hidesPrivate: boolean;
}

export async function loadLibrary(options: LoadLibraryOptions): Promise<LibraryData> {
  // 隐私规则的唯一来源 —— 见 `shouldHidePrivate` 的说明
  const hidesPrivate = shouldHidePrivate(options.viewerId, options.userId);
  const baseWhere = {
    userId: options.userId,
    ...(hidesPrivate ? { isPrivate: false } : {}),
  };

  const loadGroup = (type: CollectionStatusValue, take: number, skip = 0) =>
    prisma.collection.findMany({
      where: { ...baseWhere, type },
      orderBy: collectionOrderBy(options.query.sort),
      take,
      skip,
      include: INCLUDE,
    });

  const [rowsByType, counts, totalForFocused] = await Promise.all([
    options.focused
      ? loadGroup(
          options.focused.value,
          LIBRARY_PAGE_SIZE,
          (options.query.page - 1) * LIBRARY_PAGE_SIZE,
        ).then((rows) => new Map([[options.focused!.value, rows]]))
      : Promise.all(
          COLLECTION_STATUSES.map(
            async (meta) =>
              [meta.value, await loadGroup(meta.value, LIBRARY_GROUP_PREVIEW)] as const,
          ),
        ).then((entries) => new Map(entries)),
    prisma.collection.groupBy({
      by: ["type"],
      where: baseWhere,
      _count: { _all: true },
    }),
    options.focused
      ? prisma.collection.count({ where: { ...baseWhere, type: options.focused.value } })
      : Promise.resolve(0),
  ]);

  const allRows = [...rowsByType.values()].flat();

  /**
   * 观看进度：已看集数。
   *
   * 用**归属者**的进度记录，不是访客的 —— 看别人的追番页时要显示「他看了几集」。
   * 这一点很容易写错成 `viewerId`（复制自己的页面时），而症状是「所有集数都
   * 显示 0/x」，看起来像数据缺失。
   */
  const watchedBySubject = new Map<number, number>();
  if (allRows.length > 0) {
    const progressRows = await prisma.episodeProgress.findMany({
      where: {
        userId: options.userId,
        type: 2, // EpisodeProgress 的 Done（与条目收藏的语义不同）
        episode: { subjectId: { in: allRows.map((row) => row.subjectId) } },
      },
      select: { episode: { select: { subjectId: true } } },
    });
    for (const row of progressRows) {
      const subjectId = row.episode.subjectId;
      watchedBySubject.set(subjectId, (watchedBySubject.get(subjectId) ?? 0) + 1);
    }
  }

  return {
    rowsByType,
    countByType: new Map(counts.map((row) => [row.type, row._count._all])),
    watchedBySubject,
    totalForFocused,
    hidesPrivate,
  };
}

/**
 * 数据库行 → 列表项。
 *
 * 与取数放在一起，两个页面共用 —— 否则「别人的追番页」会各自演化出一份
 * 映射，字段一多必然漏（例如忘了带 `collectedAt`，排序显示就少一列）。
 */
export function toLibraryItem(
  row: LibraryRow,
  watchedBySubject: Map<number, number>,
): LibraryItem {
  return {
    collectionId: row.id,
    subjectId: row.subjectId,
    title: row.subject.nameCn || row.subject.name,
    originalTitle: row.subject.name,
    coverUrl: row.subject.coverUrl,
    bgmScore: row.subject.score,
    myRating: row.rating,
    myComment: row.comment,
    bgmRank: row.subject.rank,
    watchedEpisodes: watchedBySubject.get(row.subjectId) ?? 0,
    totalEpisodes: row.subject._count.episodes,
    collectedAt: row.collectedAt?.toISOString() ?? null,
    statusLabel: statusLabel(row.type),
  };
}
