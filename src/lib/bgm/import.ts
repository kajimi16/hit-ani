/**
 * Bangumi 收藏「一键导入」—— 分批、可续、可观测。
 *
 * 设计（对应真实事故：一次 12 分钟的单请求导入无声卡死 8 小时）：
 *
 *  1. **快照 + 游标**：任务启动时抓取上游收藏 ID 快照存入 `ImportJob.subjectIds`，
 *     之后每批只推进 `cursor`。上游中途变动不会造成漏项或死循环。
 *  2. **分批**：`runImportTick` 每次只处理 `BATCH_SIZE` 条，单次请求有界（约十几秒），
 *     不会因为一次代理抖动就整条链路陪葬。
 *  3. **可续**：任何一批失败/中断，下次调用从 `cursor` 继续，已完成的部分靠 upsert 幂等。
 *  4. **超时**：底层请求带超时（见 `client.ts`），超时异常可被 `withRetry` 捕获重试，
 *     不会像挂起那样让流程永久停摆。
 *
 * 上游约束：BGM 未公布限流阈值 → 串行 + 固定间隔 + 指数退避，宁可慢不可被封。
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
const REQUEST_INTERVAL_MS = 120;
/** 每批处理的条目数：约 10 秒/批，兼顾吞吐与单请求时长。 */
export const BATCH_SIZE = 12;
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

/** 落库「我」的章节进度；接口拒绝时静默返回 0，不阻断条目与章节的导入。 */
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

export interface SubjectImportResult {
  subjectId: number;
  episodes: number;
  progress: number;
}

/**
 * 导入单个条目：详情 + 章节（弹幕外键挂载点）+ 可选进度。
 * 幂等：按 `subjectId` / `episodeId` upsert，可重复执行。
 */
export async function importSubject(
  subjectId: number,
  options: { userId?: string; accessToken?: string } = {},
): Promise<SubjectImportResult> {
  const detail = await withRetry(() => getSubject(subjectId), `subject ${subjectId}`);

  const subjectFields = {
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
    create: { id: detail.id, tags: [], ...subjectFields },
    update: subjectFields,
  });

  await sleep(REQUEST_INTERVAL_MS);

  const episodes = await fetchAllEpisodes(subjectId);
  let episodeCount = 0;

  for (const episode of episodes) {
    const fields = {
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
      create: { id: episode.id, ...fields },
      update: fields,
    });
    episodeCount += 1;
  }

  const progressCount =
    options.userId && options.accessToken
      ? await importEpisodeProgress(options.userId, subjectId, options.accessToken)
      : 0;

  return { subjectId, episodes: episodeCount, progress: progressCount };
}

/* ------------------------------------------------------------------ *
 * 任务：启动 / 推进 / 查询
 * ------------------------------------------------------------------ */

export interface ImportJobStats {
  subjects: number;
  episodes: number;
  collections: number;
  progress: number;
}

export interface ImportJobFailure {
  subjectId: number;
  reason: string;
}

/** 快照中的单条收藏。只保留写 `Collection` 所需字段，避免把整棵 subject 存进 JSON。 */
export interface ImportSnapshotEntry {
  subjectId: number;
  type: number;
  comment: string | null;
  rate: number | null;
}

function readEntries(raw: unknown): ImportSnapshotEntry[] {
  return Array.isArray(raw) ? (raw as ImportSnapshotEntry[]) : [];
}

export interface ImportJobView {
  status: "running" | "done" | "failed";
  /** 快照中的条目总数 */
  total: number;
  /** 已消费的条目数 */
  processed: number;
  stats: ImportJobStats;
  /** 只保留最近若干条，避免响应体随失败累积膨胀 */
  failures: ImportJobFailure[];
  failureCount: number;
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
}

const EMPTY_STATS: ImportJobStats = {
  subjects: 0,
  episodes: 0,
  collections: 0,
  progress: 0,
};
/** 响应里最多返回的失败条目数。 */
export const MAX_REPORTED_FAILURES = 20;

function readStats(raw: unknown): ImportJobStats {
  const value = (raw ?? {}) as Partial<ImportJobStats>;
  return {
    subjects: value.subjects ?? 0,
    episodes: value.episodes ?? 0,
    collections: value.collections ?? 0,
    progress: value.progress ?? 0,
  };
}

function readFailures(raw: unknown): ImportJobFailure[] {
  return Array.isArray(raw) ? (raw as ImportJobFailure[]) : [];
}

function toView(job: {
  status: string;
  entries: unknown;
  cursor: number;
  stats: unknown;
  failures: unknown;
  lastError: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}): ImportJobView {
  const failures = readFailures(job.failures);
  return {
    status: job.status as ImportJobView["status"],
    total: readEntries(job.entries).length,
    processed: job.cursor,
    stats: readStats(job.stats),
    failures: failures.slice(-MAX_REPORTED_FAILURES),
    failureCount: failures.length,
    lastError: job.lastError,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** 读取当前导入任务；从未导入过返回 null。 */
export async function getImportJob(userId: string): Promise<ImportJobView | null> {
  const job = await prisma.importJob.findUnique({ where: { userId } });
  return job ? toView(job) : null;
}

/**
 * 把快照条目写成本地收藏关系。
 * 调用前必须保证对应 `Subject` 已存在 —— `Collection.subjectId` 是外键。
 */
async function upsertCollection(
  userId: string,
  entry: ImportSnapshotEntry,
): Promise<void> {
  const fields = {
    type: entry.type,
    comment: entry.comment,
    rating: entry.rate,
  };
  await prisma.collection.upsert({
    where: { userId_subjectId: { userId, subjectId: entry.subjectId } },
    create: { userId, subjectId: entry.subjectId, source: "bgm", ...fields },
    update: fields,
  });
}

/** 上游收藏 → 快照。裁掉 subject 子树，避免 JSON 膨胀。 */
function snapshotOf(collections: UserSubjectCollection[]): ImportSnapshotEntry[] {
  return collections.map((item) => ({
    subjectId: item.subject_id,
    type: item.type,
    comment: item.comment ?? null,
    rate: item.rate || null,
  }));
}

/**
 * 启动新任务：抓取上游收藏快照并落库，游标归零。
 *
 * 只做快照，**不**写 `Collection` —— `Collection.subjectId` 是指向 `Subject` 的外键，
 * 而本地条目要等 `runImportTick` 逐条导入后才存在。顺序反了会直接触发外键约束失败。
 */
export async function startImportJob(
  userId: string,
  options: { username: string; accessToken: string; subjectType?: number },
): Promise<ImportJobView> {
  const collections = await fetchAllCollections(
    options.username,
    options.accessToken,
    options.subjectType ?? 2,
  );

  const job = await prisma.importJob.upsert({
    where: { userId },
    create: {
      userId,
      status: "running",
      entries: snapshotOf(collections) as never,
      cursor: 0,
      stats: EMPTY_STATS as never,
      failures: [] as never,
    },
    update: {
      status: "running",
      entries: snapshotOf(collections) as never,
      cursor: 0,
      stats: EMPTY_STATS as never,
      failures: [] as never,
      lastError: null,
      startedAt: new Date(),
      finishedAt: null,
    },
  });

  return toView(job);
}

/**
 * 推进一批。返回推进后的任务状态；已结束时直接把 `done` 返回给调用方。
 *
 * 单条失败只记入 `failures` 并继续 —— 一条坏数据不该毁掉整次导入。
 */
export async function runImportTick(
  userId: string,
  accessToken: string,
): Promise<ImportJobView> {
  const job = await prisma.importJob.findUnique({ where: { userId } });
  if (!job) throw new Error("没有进行中的导入任务");
  if (job.status !== "running") return toView(job);

  const stats = readStats(job.stats);
  const failures = readFailures(job.failures);

  const entries = readEntries(job.entries);
  const start = job.cursor;
  const end = Math.min(start + BATCH_SIZE, entries.length);
  const batch = entries.slice(start, end);

  let lastError: string | null = job.lastError;

  for (const entry of batch) {
    const { subjectId } = entry;
    try {
      const result = await importSubject(subjectId, { userId, accessToken });
      stats.subjects += 1;
      stats.episodes += result.episodes;
      stats.progress += result.progress;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ subjectId, reason });
      lastError = `subject ${subjectId}: ${reason}`;
      console.warn(`[bgm-import] subject=${subjectId} 导入失败：${reason}`);
      await sleep(REQUEST_INTERVAL_MS);
      continue;
    }

    // 条目已存在才能写收藏关系（外键约束）；单独 try 保证收藏写失败不影响条目本身
    try {
      await upsertCollection(userId, entry);
      stats.collections += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ subjectId, reason: `收藏关系写入失败：${reason}` });
      lastError = `subject ${subjectId} 收藏写入失败：${reason}`;
      console.warn(`[bgm-import] subject=${subjectId} 收藏写入失败：${reason}`);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  const done = end >= entries.length;

  const updated = await prisma.importJob.update({
    where: { userId },
    data: {
      cursor: end,
      stats: stats as never,
      failures: failures as never,
      status: done ? "done" : "running",
      lastError,
      finishedAt: done ? new Date() : null,
    },
  });

  // 全部完成才更新绑定表的同步时间，供 UI 判断「是否需要重新导入」。
  // 用 updateMany：绑定在导入途中被解除时这是 no-op，不应让「完成」这一转换失败。
  if (done) {
    await prisma.bgmBinding.updateMany({
      where: { userId },
      data: { syncedAt: new Date() },
    });
  }

  return toView(updated);
}
