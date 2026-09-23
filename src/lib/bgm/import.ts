/**
 * Bangumi 收藏导入 —— **轻量导入 + 访问时补齐**。
 *
 * ## 为什么不逐条拉详情
 *
 * 收藏列表接口（`GET /v0/users/{username}/collections`）的每条记录都**内嵌了
 * `SlimSubject`**（含封面 / 名称 / 中文名 / 评分 / 排名 / 标签），足以渲染追番列表。
 *
 * 早先的实现对每个收藏都额外打两次请求（条目详情 + 章节），377 个收藏 =
 * 上千次请求、447 秒。而这些数据在用户没点进那部番之前**完全用不上**。
 *
 * 现在分两层：
 *
 * | 层 | 时机 | 成本 |
 * | --- | --- | --- |
 * | **轻量数据**（条目骨架 + 收藏关系） | 导入时 | 分页拉收藏，377 条 = 4 次请求 |
 * | **完整数据**（简介 + 章节 + 我的进度） | 用户打开该条目时 | 该条目 3 次请求 |
 *
 * 判据是 `Subject.detailSyncedAt`：null 表示只有轻量数据。
 *
 * ## 上游约束
 *
 * BGM 未公布限流阈值 → 串行 + 固定间隔 + 指数退避，宁可慢不可被封。
 */

import { prisma } from "@/lib/prisma";
import {
  getSubject,
  getSubjectEpisodes,
  getUserCollections,
  getUserSubjectEpisodeCollection,
  isRetryable,
  type Episode,
  type PagedUserEpisodeCollections,
  type UserSubjectCollection,
} from "@/lib/bgm/client";

/** 单次上游请求之间的间隔。BGM 限流阈值未公开，保守取值。 */
const REQUEST_INTERVAL_MS = 220;
const PAGE_SIZE = 100;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带指数退避的重试。
 *
 * 可重试的判定见 `isRetryable`：429/5xx（上游抖动）与 `TimeoutError`（我们自己的超时）。
 * `AbortError` 不重试 —— 那是调用方主动放弃。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) throw error;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      console.warn(`[bgm-import] ${label} 失败，${backoff}ms 后重试（第 ${attempt + 1} 次）`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/** `YYYY-MM-DD` → Date；BGM 对未定档条目会返回空串。 */
export function parseAirDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 分页拉全量收藏。`subjectType=2` 限定动画。 */
export async function fetchAllCollections(
  username: string,
  accessToken: string,
  subjectType = 2,
): Promise<UserSubjectCollection[]> {
  const all: UserSubjectCollection[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const page = await withRetry(
      () =>
        getUserCollections(
          username,
          { subject_type: subjectType as never, limit: PAGE_SIZE, offset },
          { accessToken },
        ),
      `collections offset=${offset}`,
    );

    total = page.total;
    all.push(...page.data);
    offset += page.limit || PAGE_SIZE;

    if (page.data.length === 0) break;
    if (offset < total) await sleep(REQUEST_INTERVAL_MS);
  }

  return all;
}

/* ------------------------------------------------------------------ *
 * 轻量导入
 * ------------------------------------------------------------------ */

export interface ImportStats {
  subjects: number;
  collections: number;
  /** 更新（已存在）与新建的条数，便于判断是首次导入还是增量 */
  created: number;
  updated: number;
}

/**
 * 全量导入收藏（**只写轻量数据**）。
 *
 * 请求量 = ⌈收藏数 / 100⌉ + 1。377 条收藏只需 4 次上游请求。
 * 幂等：按 `subjectId` upsert，可重复执行。
 */
export async function importUserLibrary(
  userId: string,
  options: { username: string; accessToken: string; subjectType?: number },
): Promise<ImportStats> {
  const collections = await fetchAllCollections(
    options.username,
    options.accessToken,
    options.subjectType ?? 2,
  );

  const stats: ImportStats = { subjects: 0, collections: 0, created: 0, updated: 0 };

  // 先查已有条目，用于区分新建/更新（不影响正确性，只影响统计展示）
  const existingIds = new Set(
    (
      await prisma.subject.findMany({
        where: { id: { in: collections.map((item) => item.subject_id) } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  for (const item of collections) {
    // 顺序必须是「先 Subject 后 Collection」—— 后者对前者有外键。
    // 反过来会直接触发外键约束失败。
    await upsertSlimSubject(item);
    await upsertCollection(userId, item);

    stats.subjects += 1;
    stats.collections += 1;
    if (existingIds.has(item.subject_id)) stats.updated += 1;
    else stats.created += 1;
  }

  await prisma.bgmBinding.updateMany({
    where: { userId },
    data: { syncedAt: new Date() },
  });

  return stats;
}

/**
 * 写入轻量条目数据。
 *
 * 字段全部来自收藏列表内嵌的 `SlimSubject`，**不额外发请求**。
 * `detailSyncedAt` 保持 null —— 表示「还没拉过完整详情」，
 * 用户打开该条目时由 `enrichSubject` 补齐。
 */
async function upsertSlimSubject(item: UserSubjectCollection): Promise<void> {
  const subject = item.subject;
  if (!subject) {
    // 理论上 SlimSubject 总会返回；缺失时至少保住 ID，避免外键失败
    await prisma.subject.upsert({
      where: { id: item.subject_id },
      create: { id: item.subject_id, type: item.subject_type, name: String(item.subject_id), tags: [] },
      update: {},
    });
    return;
  }

  const fields = {
    type: subject.type ?? item.subject_type,
    name: subject.name,
    nameCn: subject.name_cn || null,
    // SlimSubject 给的是截短简介；完整简介等 enrichSubject
    summary: subject.short_summary || null,
    coverUrl: subject.images?.large ?? subject.images?.common ?? null,
    score: subject.score || null,
    rank: subject.rank || null,
    // SlimSubject 的 tags 是对象数组（含 count），本地只需要名字
    tags: (subject.tags ?? []).map((tag) => tag.name),
  };

  await prisma.subject.upsert({
    where: { id: item.subject_id },
    create: { id: item.subject_id, ...fields },
    // 不覆盖 detailSyncedAt —— 已拉过详情的条目不该被降级回轻量态
    update: fields,
  });
}

/** 写收藏关系。调用前必须保证对应 `Subject` 已存在（外键）。 */
async function upsertCollection(
  userId: string,
  item: UserSubjectCollection,
): Promise<void> {
  const fields = {
    type: item.type,
    comment: item.comment ?? null,
    rating: item.rate || null,
  };
  await prisma.collection.upsert({
    where: { userId_subjectId: { userId, subjectId: item.subject_id } },
    create: { userId, subjectId: item.subject_id, source: "bgm", ...fields },
    update: fields,
  });
}

/* ------------------------------------------------------------------ *
 * 访问时补齐
 * ------------------------------------------------------------------ */

export interface SubjectEnrichResult {
  subjectId: number;
  episodes: number;
  progress: number;
  /** true 表示本次真的去上游拉了数据；false 表示已有缓存直接返回 */
  fetched: boolean;
}

/**
 * 补齐某条目的完整数据：详情 + 章节 + 该用户的单集进度。
 *
 * 由条目页在访问时调用。已是完整状态（`detailSyncedAt` 非空且章节存在）时
 * 直接返回，不发请求。
 *
 * 章节必须落库 —— `Danmaku.episodeId` 是外键，没有 `Episode` 行就发不出弹幕。
 */
export async function enrichSubject(
  subjectId: number,
  options: { userId?: string; accessToken?: string; force?: boolean } = {},
): Promise<SubjectEnrichResult> {
  const existing = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { detailSyncedAt: true, _count: { select: { episodes: true } } },
  });

  const hasDetail = existing?.detailSyncedAt !== null && existing?.detailSyncedAt !== undefined;
  const hasEpisodes = (existing?._count.episodes ?? 0) > 0;

  if (!options.force && hasDetail && hasEpisodes) {
    return { subjectId, episodes: existing!._count.episodes, progress: 0, fetched: false };
  }

  const detail = await withRetry(() => getSubject(subjectId), `subject ${subjectId}`);

  const fields = {
    type: detail.type,
    name: detail.name,
    nameCn: detail.name_cn || null,
    summary: detail.summary || null,
    coverUrl: detail.images?.large ?? detail.images?.common ?? null,
    airDate: parseAirDate(detail.date),
    score: detail.rating?.score ?? null,
    rank: detail.rating?.rank ?? null,
  };

  await prisma.subject.upsert({
    where: { id: detail.id },
    create: { id: detail.id, tags: [], ...fields },
    update: fields,
  });

  await sleep(REQUEST_INTERVAL_MS);

  const episodes = await fetchAllEpisodes(subjectId);
  let episodeCount = 0;

  for (const episode of episodes) {
    const episodeFields = {
      subjectId,
      sort: episode.sort,
      ep: episode.ep ?? null,
      name: episode.name,
      nameCn: episode.name_cn || null,
      airdate: parseAirDate(episode.airdate),
      duration: episode.duration || null,
    };
    await prisma.episode.upsert({
      where: { id: episode.id },
      create: { id: episode.id, ...episodeFields },
      update: episodeFields,
    });
    episodeCount += 1;
  }

  const progressCount =
    options.userId && options.accessToken
      ? await importEpisodeProgress(options.userId, subjectId, options.accessToken)
      : 0;

  // 标记完成 —— 下次访问直接走缓存
  await prisma.subject.update({
    where: { id: subjectId },
    data: { detailSyncedAt: new Date() },
  });

  return { subjectId, episodes: episodeCount, progress: progressCount, fetched: true };
}

/** 分页拉某条目全部章节。 */
async function fetchAllEpisodes(subjectId: number): Promise<Episode[]> {
  const all: Episode[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const page = await withRetry(
      () => getSubjectEpisodes(subjectId, { limit: PAGE_SIZE, offset }),
      `episodes subject=${subjectId} offset=${offset}`,
    );
    total = page.total;
    all.push(...page.data);
    offset += page.limit || PAGE_SIZE;
    if (page.data.length === 0) break;
    if (offset < total) await sleep(REQUEST_INTERVAL_MS);
  }

  return all;
}

/**
 * 落库「我」的章节进度。接口拒绝时静默返回 0 ——
 * 进度拉不到不该阻断章节与详情的缓存。
 */
async function importEpisodeProgress(
  userId: string,
  subjectId: number,
  accessToken: string,
): Promise<number> {
  let entries: NonNullable<PagedUserEpisodeCollections["data"]> = [];
  try {
    const page = await withRetry(
      () =>
        getUserSubjectEpisodeCollection(
          subjectId,
          { limit: PAGE_SIZE, offset: 0 },
          { accessToken },
        ),
      `progress subject=${subjectId}`,
    );
    entries = page.data ?? [];
  } catch (error) {
    console.warn(
      `[bgm-import] 跳过 subject=${subjectId} 的进度（${error instanceof Error ? error.message : String(error)}）`,
    );
    return 0;
  }

  let count = 0;
  for (const entry of entries) {
    await prisma.episodeProgress.upsert({
      where: { userId_episodeId: { userId, episodeId: entry.episode.id } },
      create: { userId, episodeId: entry.episode.id, type: entry.type },
      update: { type: entry.type },
    });
    count += 1;
  }
  return count;
}
