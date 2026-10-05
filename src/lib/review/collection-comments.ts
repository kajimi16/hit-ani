/**
 * 收藏短评（`Collection.comment`）—— 作为评论区的一个来源。
 *
 * ## 为什么需要它
 *
 * 项目里存在**两套互不相通的「评论」**：
 *
 * | 来源 | 写在哪 | 谁会看到 |
 * |---|---|---|
 * | `Review` 表 | 本站的「评论 / 影评」表单 | 只有在本站写过评论的人 |
 * | `Collection.comment` | 在 Bangumi 收藏时顺手写的短评（导入时带入） | **只在时光机出现** |
 *
 * 于是「我在 BGM 上写过的短评」在详情页找不到 —— 用户实测报的就是这个：
 * 474 条收藏短评，详情页一条都不显示，而时光机显示。
 *
 * 两者在语义上都是「对这部番的一句话评价」，因此详情页的评论区应当同时
 * 展示它们，各自标明来源。
 *
 * ## 隐私：与时光机同一套规则
 *
 * `Collection.isPrivate` 为真的收藏，其短评**不能展示给他人** ——
 * 那是用户在 BGM 上明确设为私密的内容。只有本人能看到自己的私密短评。
 * 这条规则与 `timeline/repository.ts` 完全一致，改动时必须两处同步。
 */

import { statusLabel } from "@/lib/collection";
import { prisma } from "@/lib/prisma";

export interface CollectionCommentDto {
  /** 用 `collection:{id}` 前缀，避免与 `Review` 的 id 撞车（前端按 id 去重）。 */
  id: string;
  subjectId: number;
  /** 短评正文。 */
  comment: string;
  /** 该收藏的评分（1–10），未评为 null。 */
  rating: number | null;
  /** 收藏状态（中文标签）。 */
  statusLabel: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  schoolId: string;
  /** 是否是当前登录用户自己写的 —— 界面据此标「我的」。 */
  isMine: boolean;
  /** 收藏时间（用于排序）；缺失时退回 updatedAt。 */
  at: string;
}

/**
 * 某条收藏短评是否对当前访客可见。
 *
 * 抽成纯函数是因为这是**隐私边界**：`Collection.isPrivate` 为真的收藏是用户在
 * BGM 上明确设为私密的内容，展示给别人就是泄露。而这类错误没有报错、
 * 界面看起来也正常 —— 只有测试能拦住。
 *
 * 规则与 `timeline/repository.ts` 完全一致：私密的只有本人能看。
 */
export function isCommentVisible(
  comment: { isPrivate: boolean; userId: string },
  viewerId: string | null,
): boolean {
  if (!comment.isPrivate) return true;
  return viewerId !== null && comment.userId === viewerId;
}

export interface ListCollectionCommentsOptions {
  subjectId: number;
  /** 当前用户 id；未登录为 null。用于判定 `isMine` 与放行自己的私密短评。 */
  viewerId: string | null;
  /** true 时只看本校。 */
  schoolOnly?: boolean;
  schoolId?: string;
  limit?: number;
}

/**
 * 取某条目的收藏短评。
 *
 * 排序用 `collectedAt desc`（与时光机一致），并列时 `id asc` 收尾 ——
 * 批量导入的短评时间戳常常相同，没有收尾键就会每次刷新换顺序。
 */
export async function listCollectionComments(
  options: ListCollectionCommentsOptions,
): Promise<CollectionCommentDto[]> {
  const rows = await prisma.collection.findMany({
    where: {
      subjectId: options.subjectId,
      // 空字符串不算短评（BGM 对未填写返回空串）
      comment: { not: null },
      ...(options.schoolOnly && options.schoolId
        ? { user: { schoolId: options.schoolId } }
        : {}),
    },
    orderBy: [{ collectedAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
    take: Math.min(options.limit ?? 50, 100),
    select: {
      id: true,
      subjectId: true,
      type: true,
      comment: true,
      rating: true,
      isPrivate: true,
      collectedAt: true,
      updatedAt: true,
      userId: true,
      user: { select: { nickname: true, avatarUrl: true, schoolId: true } },
    },
  });

  return rows
    // 空串再挡一次（`comment: { not: null }` 挡不住空串）
    .filter((row) => (row.comment ?? "").trim().length > 0)
    // 私密收藏的短评只有本人可见 —— 见 `isCommentVisible` 的说明
    .filter((row) => isCommentVisible({ isPrivate: row.isPrivate, userId: row.userId }, options.viewerId))
    .map((row) => ({
      id: `collection:${row.id}`,
      subjectId: row.subjectId,
      comment: row.comment!.trim(),
      rating: row.rating,
      statusLabel: statusLabel(row.type),
      authorId: row.userId,
      authorName: row.user.nickname,
      authorAvatar: row.user.avatarUrl,
      schoolId: row.user.schoolId,
      isMine: options.viewerId !== null && row.userId === options.viewerId,
      at: (row.collectedAt ?? row.updatedAt).toISOString(),
    }));
}
