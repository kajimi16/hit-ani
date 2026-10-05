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
import { parseCollectedAt } from "@/lib/bgm/collected-at";
import { subjectFieldsFromDetail, subjectFieldsFromSlim } from "@/lib/bgm/subject-fields";
import { parseIsoDate } from "@/lib/date";
import {
  getSubject,
  getSubjectEpisodes,
  getSubjectPersons,
  getUserCollections,
  getUserSubjectEpisodeCollection,
  sleep,
  withRetry,
  type Episode,
  type PagedUserEpisodeCollections,
  type UserSubjectCollection,
} from "@/lib/bgm/client";

/** 单次上游请求之间的间隔。BGM 限流阈值未公开，保守取值。 */
const REQUEST_INTERVAL_MS = 220;
const PAGE_SIZE = 100;
/** 重试与退避由 `withRetry` 承担，见 `src/lib/bgm/client.ts`。 */


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

  // 同样来自 `subject-fields.ts`。这条路径**不能**写 ratingTotal /
  // ratingHistogram —— SlimSubject 里没有，写进去只会把已有的值抹成空。
  const fields = {
    ...subjectFieldsFromSlim(subject),
    type: subject.type ?? item.subject_type,
  };

  await prisma.subject.upsert({
    where: { id: item.subject_id },
    create: { id: item.subject_id, ...fields },
    // 不覆盖 detailSyncedAt —— 已拉过详情的条目不该被降级回轻量态
    update: fields,
  });
}

/**
 * 写收藏关系。调用前必须保证对应 `Subject` 已存在（外键）。
 *
 * ## `collectedAt` 来自哪里
 *
 * BGM 的收藏接口**没有** `created_at` —— 唯一的字段是 `updated_at`
 * （「最后修改时间」）。这也是 BGM 自己站内「收藏时间」排序所用的值：
 * 对绝大多数「加进去就没再动过」的条目，它就等于加入收藏的时间。
 *
 * 因此我们存它、并在界面上叫「加入时间」—— 与用户的说法和 BGM 的惯例一致。
 * 别指望它是精确的「创建时间」，这一点在字段注释里已写明。
 *
 * `collectedAt` 是**条件键**：上游没给或解析不出来时整个键缺席。
 * 不然一次「上游少了这个字段」的导入会把已有时间清成 null，
 * 排序随即全乱 —— 与本项目此前踩过的 `ratingTotal` / `airDate` 完全同类。
 */
async function upsertCollection(
  userId: string,
  item: UserSubjectCollection,
): Promise<void> {
  const collectedAt = parseCollectedAt(item.updated_at);

  const fields = {
    type: item.type,
    comment: item.comment ?? null,
    rating: item.rate || null,
    ...(collectedAt ? { collectedAt } : {}),
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
  /** 本次同步到的制作人员条数（0 表示未同步或接口失败）。 */
  staff: number;
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
    select: {
      detailSyncedAt: true,
      staffSyncedAt: true,
      _count: { select: { episodes: true, persons: true } },
    },
  });

  const hasDetail = existing?.detailSyncedAt != null;
  const hasEpisodes = (existing?._count.episodes ?? 0) > 0;
  /*
   * 制作人员也算「补齐」的一部分。
   *
   * 这一条是为了**回填**：在加入人员同步之前就已经缓存过的条目，
   * `detailSyncedAt` 有值、章节也有，于是会被下面判为「已完整」而直接返回 ——
   * 结果 `staffSyncedAt` 永远是 null，这些条目的制作人员永远拉不到，
   * 顺带 `ratingTotal` / 评分直方图也补不上（它们只在详情那一趟里写）。
   *
   * 旧条目因此会在部署后**第一次被访问时**多走一轮详情 + 人员请求，
   * 之后照常命中缓存。这是既有的「访问时补齐」策略的自然延伸，
   * 一次性成本换自愈，比要求手动重跑一遍导入合理。
   */
  const hasStaff = existing?.staffSyncedAt != null;

  if (!options.force && hasDetail && hasEpisodes && hasStaff) {
    return {
      subjectId,
      episodes: existing._count.episodes,
      progress: 0,
      staff: existing._count.persons,
      fetched: false,
    };
  }

  const detail = await withRetry(() => getSubject(subjectId), `subject ${subjectId}`);

  // 字段清单在 `subject-fields.ts` 里集中定义 —— 此前这里与
  // `api/subjects/[id]/route.ts` 各写一份，结果两边漏的字段还不一样
  // （一边漏 rank、一边漏 ratingTotal），而漏键不是类型错误，tsc 抓不到。
  const fields = subjectFieldsFromDetail(detail);

  await prisma.subject.upsert({
    where: { id: detail.id },
    create: { id: detail.id, ...fields },
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
      airdate: parseIsoDate(episode.airdate),
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

  const staffCount = await syncSubjectPersons(subjectId);

  // 标记完成 —— 下次访问直接走缓存
  await prisma.subject.update({
    where: { id: subjectId },
    data: { detailSyncedAt: new Date() },
  });

  return {
    subjectId,
    episodes: episodeCount,
    progress: progressCount,
    staff: staffCount,
    fetched: true,
  };
}

/**
 * 同步条目的制作人员。
 *
 * 用 `staffSyncedAt` 单独判定，与 `detailSyncedAt` 分开 —— 人员接口挂了不该
 * 让整条条目被判为「未同步」，否则每次打开都会把详情与全部章节重拉一遍。
 *
 * 失败时**不抛出**：制作人员是详情页的附加信息，拿不到就不显示那个板块，
 * 没道理因此让整个条目页报错。返回 0 表示这次没同步到。
 */
async function syncSubjectPersons(subjectId: number): Promise<number> {
  const existing = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { staffSyncedAt: true, _count: { select: { persons: true } } },
  });
  if (existing?.staffSyncedAt) return existing._count.persons;

  let persons;
  try {
    persons = await withRetry(() => getSubjectPersons(subjectId), `persons ${subjectId}`, 2);
  } catch (error) {
    console.warn(`[bgm-import] 制作人员同步失败（不影响条目）：${String(error)}`);
    return 0;
  }

  await prisma.$transaction([
    // 先清后写：上游删掉某个职位时本地也要跟着消失，否则会留下幽灵人员。
    // 同一个人担任多个职位不受影响 —— 主键是「条目 + 人员 + 职位」。
    prisma.subjectPerson.deleteMany({ where: { subjectId } }),
    prisma.subjectPerson.createMany({
      data: persons.map((person, index) => ({
        subjectId,
        personId: person.id,
        relation: person.relation,
        name: person.name,
        career: person.career ?? [],
        imageUrl: person.images?.medium ?? person.images?.small ?? null,
        // 上游已按重要度排好序，照它的顺序存
        sort: index,
      })),
      skipDuplicates: true,
    }),
    prisma.subject.update({ where: { id: subjectId }, data: { staffSyncedAt: new Date() } }),
  ]);

  return persons.length;
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
