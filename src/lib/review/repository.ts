/**
 * 评论 / 影评仓储。
 *
 * BGM 只允许写入「自己收藏下的那一条 comment 字符串」，读不到任何人的评论列表
 * （旧版 `/ep/{id}/comments`、`/subject/{id}/reviews` 均已 404）。
 * 因此评论与影评完全自建，`schoolId` 冗余落库以支持「只读本校」筛选。
 */

import { prisma } from "@/lib/prisma";

export const ReviewKind = {
  /** 短评 */
  Short: 0,
  /** 长评（影评） */
  Long: 1,
} as const;

export type ReviewKindValue = (typeof ReviewKind)[keyof typeof ReviewKind];

export interface ReviewDto {
  id: string;
  subjectId: number;
  kind: ReviewKindValue;
  title: string | null;
  content: string;
  rating: number | null;
  schoolId: string;
  authorId: string;
  authorName: string;
  authorAvatar: string | null;
  likes: number;
  createdAt: string;
}

export interface CreateReviewInput {
  subjectId: number;
  kind: ReviewKindValue;
  title?: string | null;
  content: string;
  rating?: number | null;
}

export interface ListReviewOptions {
  subjectId: number;
  kind?: ReviewKindValue;
  /** true 时只返回本校评论 —— 与弹幕一致，用索引命中而非后置过滤。 */
  schoolOnly?: boolean;
  schoolId?: string;
  limit?: number;
  offset?: number;
}

function toDto(row: {
  id: string;
  subjectId: number;
  kind: number;
  title: string | null;
  content: string;
  rating: number | null;
  schoolId: string;
  userId: string;
  likes: number;
  createdAt: Date;
  user: { nickname: string; avatarUrl: string | null };
}): ReviewDto {
  return {
    id: row.id,
    subjectId: row.subjectId,
    kind: row.kind as ReviewKindValue,
    title: row.title,
    content: row.content,
    rating: row.rating,
    schoolId: row.schoolId,
    authorId: row.userId,
    authorName: row.user.nickname,
    authorAvatar: row.user.avatarUrl,
    likes: row.likes,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listReviews(options: ListReviewOptions): Promise<ReviewDto[]> {
  const rows = await prisma.review.findMany({
    where: {
      subjectId: options.subjectId,
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.schoolOnly && options.schoolId ? { schoolId: options.schoolId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(options.limit ?? 20, 100),
    skip: options.offset ?? 0,
    select: {
      id: true,
      subjectId: true,
      kind: true,
      title: true,
      content: true,
      rating: true,
      schoolId: true,
      userId: true,
      likes: true,
      createdAt: true,
      user: { select: { nickname: true, avatarUrl: true } },
    },
  });
  return rows.map(toDto);
}

export async function createReview(
  userId: string,
  input: CreateReviewInput,
): Promise<ReviewDto> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, schoolId: true, nickname: true, avatarUrl: true },
  });

  const row = await prisma.review.create({
    data: {
      userId: user.id,
      schoolId: user.schoolId,
      subjectId: input.subjectId,
      kind: input.kind,
      title: input.title ?? null,
      content: input.content,
      rating: input.rating ?? null,
    },
    select: {
      id: true,
      subjectId: true,
      kind: true,
      title: true,
      content: true,
      rating: true,
      schoolId: true,
      userId: true,
      likes: true,
      createdAt: true,
    },
  });

  return toDto({ ...row, user: { nickname: user.nickname, avatarUrl: user.avatarUrl } });
}

/** 本校 / 全体评论数，用于详情页对比展示。 */
export async function countReviews(
  subjectId: number,
  schoolId?: string,
): Promise<number> {
  return prisma.review.count({
    where: { subjectId, ...(schoolId ? { schoolId } : {}) },
  });
}
