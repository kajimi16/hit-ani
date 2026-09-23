/**
 * 弹幕仓储层 —— 唯一与 Prisma 打交道的地方。
 *
 * `schoolId` 在写入时从 User 冗余落库，使「只看本校」成为索引命中
 * （`@@index([episodeId, schoolId, playTimeMs])`）而非后置过滤。
 */

import { prisma } from "@/lib/prisma";
import { normalizeQuery, sanitizeDanmakuText } from "./engine";
import {
  DanmakuLocation,
  DanmakuServiceId,
  DanmakuStatus,
  type DanmakuDto,
  type DanmakuQuery,
  type DanmakuSendInput,
} from "./types";

interface DanmakuRow {
  id: string;
  episodeId: number;
  serviceId: string;
  userId: string;
  schoolId: string;
  playTimeMs: number;
  text: string;
  color: number;
  location: number;
  user?: { nickname: string } | null;
}

function toDto(row: DanmakuRow): DanmakuDto {
  return {
    id: row.id,
    episodeId: row.episodeId,
    serviceId: row.serviceId,
    senderId: row.userId,
    senderName: row.user?.nickname ?? "匿名",
    schoolId: row.schoolId,
    playTimeMs: row.playTimeMs,
    color: row.color,
    text: row.text,
    location: row.location as DanmakuDto["location"],
  };
}

/**
 * 拉取某集的弹幕。
 * 过滤与排序全部下推到数据库，避免把整集弹幕读进内存再筛。
 */
export async function listDanmaku(query: DanmakuQuery): Promise<DanmakuDto[]> {
  const q = normalizeQuery(query);

  const rows = await prisma.danmaku.findMany({
    where: {
      episodeId: q.episodeId,
      status: DanmakuStatus.Normal,
      ...(q.schoolOnly && q.schoolId ? { schoolId: q.schoolId } : {}),
      ...(q.fromMs !== undefined || q.toMs !== undefined
        ? {
            playTimeMs: {
              ...(q.fromMs !== undefined ? { gte: q.fromMs } : {}),
              ...(q.toMs !== undefined ? { lte: q.toMs } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ playTimeMs: "asc" }, { id: "asc" }],
    take: q.limit,
    select: {
      id: true,
      episodeId: true,
      serviceId: true,
      userId: true,
      schoolId: true,
      playTimeMs: true,
      text: true,
      color: true,
      location: true,
      user: { select: { nickname: true } },
    },
  });

  return rows.map(toDto);
}

export interface CreateDanmakuResult {
  danmaku: DanmakuDto;
}

/**
 * 写入一条弹幕。
 * `schoolId` 从用户记录读取后冗余落库，调用方不需要（也不应该）相信客户端传的 schoolId。
 */
export async function createDanmaku(
  userId: string,
  input: DanmakuSendInput,
): Promise<CreateDanmakuResult> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, schoolId: true, nickname: true },
  });

  const row = await prisma.danmaku.create({
    data: {
      episodeId: input.episodeId,
      userId: user.id,
      schoolId: user.schoolId,
      playTimeMs: Math.round(input.playTimeMs),
      text: sanitizeDanmakuText(input.text),
      color: input.color ?? 0xffffff,
      location: input.location ?? DanmakuLocation.Normal,
      serviceId: DanmakuServiceId.HitAni,
      status: DanmakuStatus.Normal,
    },
    select: {
      id: true,
      episodeId: true,
      serviceId: true,
      userId: true,
      schoolId: true,
      playTimeMs: true,
      text: true,
      color: true,
      location: true,
    },
  });

  return { danmaku: toDto({ ...row, user: { nickname: user.nickname } }) };
}

/** 统计某集弹幕量，用于详情页与「本校 vs 全体」对比展示。 */
export async function countDanmaku(
  episodeId: number,
  schoolId?: string,
): Promise<number> {
  return prisma.danmaku.count({
    where: {
      episodeId,
      status: DanmakuStatus.Normal,
      ...(schoolId ? { schoolId } : {}),
    },
  });
}

/** 按集聚合弹幕数（一次查询拿回整季），供章节列表展示密度。 */
export async function countByEpisodeIds(
  episodeIds: readonly number[],
  schoolId?: string,
): Promise<Record<number, number>> {
  if (episodeIds.length === 0) return {};

  const grouped = await prisma.danmaku.groupBy({
    by: ["episodeId"],
    where: {
      episodeId: { in: [...episodeIds] },
      status: DanmakuStatus.Normal,
      ...(schoolId ? { schoolId } : {}),
    },
    _count: { _all: true },
  });

  const result: Record<number, number> = {};
  for (const row of grouped) result[row.episodeId] = row._count._all;
  return result;
}
