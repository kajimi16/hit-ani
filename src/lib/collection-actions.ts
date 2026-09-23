/**
 * 收藏状态的写路径：本地为准，BGM 为镜像。
 *
 * 与 `@/lib/collection`（纯词汇/映射）分工明确：本模块是**唯一**会写库和调上游的地方。
 *
 * 设计取舍：
 * - **本地先写**，保证离线/上游故障时用户操作不丢；
 * - 再尝试镜像到 Bangumi，失败只回报 `bgmSynced: false` 而不回滚 ——
 *   用户的意图已被本地记录，上游失败属于可重试的外部问题；
 * - 未绑定 BGM 时完全不调用上游（个人令牌模式下这是常态）。
 */

import { statusLabel, type CollectionStatusValue } from "@/lib/collection";
import { postUserCollection } from "@/lib/bgm/client";
import { decideMirror, logMirrorWrite } from "@/lib/bgm/mirror-guard";
import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { prisma } from "@/lib/prisma";

export interface SetCollectionStatusResult {
  subjectId: number;
  status: CollectionStatusValue;
  statusLabel: string;
  /** 上游镜像结果；未绑定 BGM 时为 null。 */
  bgmSynced: boolean | null;
  /** 镜像失败原因；成功或未绑定时为 null。 */
  bgmError: string | null;
  /** 本地是否新建了收藏记录（false = 更新已有）。 */
  created: boolean;
}

export interface SetCollectionStatusOptions {
  userId: string;
  subjectId: number;
  status: CollectionStatusValue;
  /** 评分 1–10；`null` 表示清除评分。仅在提供时写入。 */
  rating?: number | null;
  /** 短评；仅在提供时写入。 */
  comment?: string | null;
  /** 是否绑定 BGM（由调用方从会话取，避免这里多查一次库）。 */
  bgmBound: boolean;
  /**
   * 账号邮箱。用于判断是否允许写上游 ——
   * 测试账号（`smoke-*` / `test-*`）一律不写，见 `mirror-guard.ts`。
   */
  userEmail?: string | null;
  /** 用于解析 OAuth 回调地址；纯个人令牌模式不会用到。 */
  origin: string;
}

/**
 * 读取当前状态；未收藏返回 null。
 */
export async function getCollectionStatus(
  userId: string,
  subjectId: number,
): Promise<CollectionStatusValue | null> {
  const row = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId } },
    select: { type: true },
  });
  return (row?.type as CollectionStatusValue | undefined) ?? null;
}

/**
 * 设置条目收藏状态。幂等：重复设同一状态不会产生副作用。
 */
export async function setCollectionStatus(
  options: SetCollectionStatusOptions,
): Promise<SetCollectionStatusResult> {
  const { userId, subjectId, status, rating, comment, bgmBound, origin, userEmail } = options;

  // 条目必须先在本地存在 —— `Collection.subjectId` 是外键。
  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { id: true },
  });
  if (!subject) {
    throw new Error("条目尚未缓存到本地，请先打开条目详情页");
  }

  const existing = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId } },
    select: { id: true },
  });

  const fields = {
    type: status,
    ...(rating !== undefined ? { rating } : {}),
    ...(comment !== undefined ? { comment } : {}),
  };

  await prisma.collection.upsert({
    where: { userId_subjectId: { userId, subjectId } },
    create: { userId, subjectId, source: "local", ...fields },
    update: fields,
  });

  let bgmSynced: boolean | null = null;
  let bgmError: string | null = null;

  /*
   * 闸门在发送**之前** —— 见 `mirror-guard.ts` 记录的真实事故：
   * 拿绑定了真实 Bangumi 的账号做接口测试，测试文案被写进了用户的账号。
   */
  const mirror = decideMirror({ email: userEmail });
  if (bgmBound && !mirror.allowed) {
    bgmSynced = false;
    bgmError = mirror.reason;
    console.warn(`[bgm-mirror] 已阻止写入：${mirror.reason}`);
  } else if (bgmBound) {
    try {
      const { accessToken } = await getFreshBgmAccessToken(userId, origin);
      const payload = {
        type: status,
        ...(rating !== undefined && rating !== null ? { rate: rating } : {}),
        ...(comment !== undefined && comment !== null ? { comment } : {}),
      };
      await postUserCollection(subjectId, payload, { accessToken });
      logMirrorWrite({
        userId,
        email: userEmail,
        target: "collection",
        subjectId,
        fields: payload,
      });
      bgmSynced = true;
    } catch (error) {
      bgmSynced = false;
      bgmError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    subjectId,
    status,
    statusLabel: statusLabel(status),
    bgmSynced,
    bgmError,
    created: existing === null,
  };
}

/** 把五种状态的计数一次性取回，供看板与统计使用。 */
export async function countByStatus(userId: string): Promise<Record<number, number>> {
  const rows = await prisma.collection.groupBy({
    by: ["type"],
    where: { userId },
    _count: { _all: true },
  });
  const result: Record<number, number> = {};
  for (const row of rows) result[row.type] = row._count._all;
  return result;
}
