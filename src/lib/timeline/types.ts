/**
 * 时光机的事件模型与归一化。
 *
 * ## 背景：BGM 的时光机没有 API
 *
 * Bangumi 网页端的「时光机」是**好友动态 + 微博客**的聚合流，而 v0 API
 * 里**没有任何 timeline 端点**（逐个核对过全部 `/v0/*` 路径）。因此两个
 * 时光机都得由可获得的数据重建：
 *
 * - **BGM 时光机**：该用户 BGM 收藏的活动流。我们只有收藏的
 *   `updated_at`（存在 `Collection.collectedAt`），所以每条收藏贡献一个
 *   「标记/更新」事件 —— 这是 API 能给出的最接近的语义，**不是** BGM 网页
 *   那个含日志、小组发言的完整动态。界面上如实说明这一点。
 * - **校内时光机**：本站自己产生的活动，数据完整得多 —— 收藏、评论/影评、
 *   弹幕、集数进度。
 *
 * ## 为什么归一化抽成纯函数
 *
 * 四个来源的行形状完全不同（有的挂在 `episode.subject` 上、有的直接有
 * `subjectId`），而最后要合成一条按时间排序的流。这段映射逻辑最容易写错、
 * 也最容易被忽略：漏掉一个来源不会报错，只是时光机里少了一类活动。
 * 抽出来就能逐类断言。
 */

import type { Prisma } from "@prisma/client";
import { statusLabel } from "@/lib/collection";

/** 时光机里的一条活动。 */
export type TimelineEvent =
  | {
      kind: "collection";
      id: string;
      at: Date;
      userId: string;
      nickname: string;
      avatarUrl: string | null;
      schoolId: string;
      subjectId: number;
      subjectTitle: string;
      coverUrl: string | null;
      statusLabel: string;
      rating: number | null;
      comment: string | null;
    }
  | {
      kind: "review";
      id: string;
      at: Date;
      userId: string;
      nickname: string;
      avatarUrl: string | null;
      schoolId: string;
      subjectId: number;
      subjectTitle: string;
      coverUrl: string | null;
      /** true = 长评（影评），false = 短评 */
      isLong: boolean;
      title: string | null;
      excerpt: string;
      rating: number | null;
    }
  | {
      kind: "danmaku";
      id: string;
      at: Date;
      userId: string;
      nickname: string;
      avatarUrl: string | null;
      schoolId: string;
      subjectId: number;
      subjectTitle: string;
      coverUrl: string | null;
      episodeLabel: string;
      text: string;
    }
  | {
      kind: "progress";
      id: string;
      at: Date;
      userId: string;
      nickname: string;
      avatarUrl: string | null;
      schoolId: string;
      subjectId: number;
      subjectTitle: string;
      coverUrl: string | null;
      episodeLabel: string;
      /** EpisodeProgress.type 的中文标签 */
      progressLabel: string;
      /** 折叠后包含的集数。未折叠时为 undefined（视为 1）。 */
      episodeCount?: number;
    };

/** `EpisodeProgress.type` → 标签（与 `PROGRESS_LABELS` 同源语义）。 */
export const PROGRESS_LABELS: Record<number, string> = {
  0: "取消观看",
  1: "想看",
  2: "看过",
  3: "抛弃",
};

/** 列表里最多展示的评论文本长度 —— 时光机是摘要流，不是全文页。 */
const EXCERPT_LIMIT = 120;

/** 截断长文，并把换行压成空格（多行评论在流里会撑高整行）。 */
export function excerpt(text: string, limit = EXCERPT_LIMIT): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/**
 * 把四个来源的原始行归一化成同一条流。
 *
 * 输入是**已经查好的**数组（查询在 `repository.ts`），因此这里可以纯粹地测。
 * 各来源的行交给各自的 `toEvent`，然后统一按时间倒序。
 *
 * 排序用 `at` 降序、`id` 升序收尾：同一秒内产生的多条活动（批量导入很常见）
 * 若只按时间排，每次查询顺序都可能不同，翻页会重复或漏条。
 */
export function buildTimeline(input: TimelineRows): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...input.collections.map(toCollectionEvent),
    ...input.reviews.map(toReviewEvent),
    ...input.danmakus.map(toDanmakuEvent),
    ...input.progress.map(toProgressEvent),
  ].filter((event): event is TimelineEvent => event !== null);

  const sorted = events.sort((a, b) => {
    const delta = b.at.getTime() - a.at.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });

  return foldProgress(sorted);
}

/**
 * 把「同一用户对同一条目」的连续进度事件折叠成一条。
 *
 * ## 为什么必须折叠
 *
 * 用户补看一部番时会产生几十条进度记录（实测一次 5 条、极端情况整季 12+ 条），
 * 而它们的时间戳彼此只差几毫秒。若不折叠，时光机的默认 60 条会被**同一个人的
 * 同一部番**占满 —— 其余活动（收藏、评论、弹幕）全部被挤出行外，
 * 时光机等于失效。BGM 的时光机也不会这样刷屏。
 *
 * 折叠后仍保留最有用的信息：条目、最新时间、以及期间更新了多少集。
 *
 * ## 只折叠「相邻」的
 *
 * 按时间序扫描，同一 `(userId, subjectId)` 的进度事件被并成一组；
 * 中间夹了别的活动就另起一组 —— 这样「昨晚看了两集、今天又看三集」会显示
 * 成两条，而不是一条跨度很怪的记录。
 */
export function foldProgress(events: TimelineEvent[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  /**
   * 上一段「同一人同一条目」的进度事件。
   *
   * 显式写出类型而不是用 `Extract<TimelineEvent, {kind:"progress"}>` 的自引用 ——
   * 那样 TS 会因为初始化表达式间接引用自身而判成 `any`。
   */
  type ProgressEvent = Extract<TimelineEvent, { kind: "progress" }>;
  let pending: ProgressEvent | null = null;

  const flush = (): void => {
    if (pending !== null) out.push(pending);
    pending = null;
  };

  for (const event of events) {
    if (event.kind !== "progress") {
      flush();
      out.push(event);
      continue;
    }

    if (pending !== null && pending.userId === event.userId && pending.subjectId === event.subjectId) {
      // 同一人同一条目：时间取更新的一条（列表是倒序，先来的更新），集数累加。
      const merged: number = (pending.episodeCount ?? 1) + 1;
      const previous: ProgressEvent = pending;
      pending = {
        ...previous,
        id: `${previous.id}+${event.id}`,
        episodeCount: merged,
        episodeLabel: `共 ${merged} 集`,
      };
      continue;
    }

    flush();
    pending = { ...event, episodeCount: 1 };
  }

  flush();
  return out;
}

/* ------------------------------------------------------------------ *
 * 各来源的行 → 事件
 *
 * 输入类型由 Prisma 的 `GetPayload` 从 `include` 形状**派生**，而不是手写一遍
 * 字段名，也不用 `unknown` 再 cast：
 * - 手写会漂移 —— 查询里改了 `select`，映射这边不会报错；
 * - `unknown` + cast 更糟：查询里把 `nameCn` 写成 `nameCh`，两处都不报错，
 *   运行时静默显示错的内容。
 *
 * `TIMELINE_INCLUDES` 是**唯一**一份 include 声明，查询与类型都从这里取。
 * ------------------------------------------------------------------ */

/** 四个来源共用的关联形状。`as const` 让 Prisma 能推导出具体字段。 */
export const TIMELINE_INCLUDES = {
  collection: {
    user: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    subject: { select: { id: true, name: true, nameCn: true, coverUrl: true } },
  },
  review: {
    user: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    subject: { select: { id: true, name: true, nameCn: true, coverUrl: true } },
  },
  danmaku: {
    user: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    episode: {
      select: {
        ep: true,
        sort: true,
        subject: { select: { id: true, name: true, nameCn: true, coverUrl: true } },
      },
    },
  },
  progress: {
    user: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    episode: {
      select: {
        ep: true,
        sort: true,
        subject: { select: { id: true, name: true, nameCn: true, coverUrl: true } },
      },
    },
  },
} as const;

export type TimelineRows = {
  collections: CollectionRow[];
  reviews: ReviewRow[];
  danmakus: DanmakuRow[];
  progress: ProgressRow[];
};

/** 用户字段在四个来源里形状一致，统一取出。 */
function personOf(row: { user: UserRef }) {
  return {
    userId: row.user.id,
    nickname: row.user.nickname,
    avatarUrl: row.user.avatarUrl,
    schoolId: row.user.schoolId,
  };
}

/** 条目字段：收藏与评论直接挂 `subject`；弹幕与进度要从章节再上一层。 */
function subjectOf(subject: SubjectRef) {
  return {
    subjectId: subject.id,
    subjectTitle: subject.nameCn || subject.name,
    coverUrl: subject.coverUrl,
  };
}

function toCollectionEvent(row: CollectionRow): TimelineEvent {
  // 站内手动收藏可能没有 collectedAt，退回 updatedAt（至少有个可排序的时间）
  return {
    kind: "collection",
    id: `collection:${row.id}`,
    at: row.collectedAt ?? row.updatedAt,
    ...personOf(row),
    ...subjectOf(row.subject),
    statusLabel: statusLabel(row.type),
    rating: row.rating,
    comment: row.comment ? excerpt(row.comment) : null,
  };
}

function toReviewEvent(row: ReviewRow): TimelineEvent {
  return {
    kind: "review",
    id: `review:${row.id}`,
    at: row.createdAt,
    ...personOf(row),
    ...subjectOf(row.subject),
    isLong: row.kind === 1,
    title: row.title,
    excerpt: excerpt(row.content),
    rating: row.rating,
  };
}

function toDanmakuEvent(row: DanmakuRow): TimelineEvent {
  return {
    kind: "danmaku",
    id: `danmaku:${row.id}`,
    at: row.createdAt,
    ...personOf(row),
    ...subjectOf(row.episode.subject),
    episodeLabel: `第 ${row.episode.ep ?? row.episode.sort} 集`,
    text: excerpt(row.text, 60),
  };
}

function toProgressEvent(row: ProgressRow): TimelineEvent {
  return {
    kind: "progress",
    id: `progress:${row.id}`,
    at: row.updatedAt,
    ...personOf(row),
    ...subjectOf(row.episode.subject),
    episodeLabel: `第 ${row.episode.ep ?? row.episode.sort} 集`,
    progressLabel: PROGRESS_LABELS[row.type] ?? "更新进度",
  };
}

/* ------------------------------------------------------------------ *
 * 行类型与引用形状
 * ------------------------------------------------------------------ */

/** 关联用户的三字段 —— 四个来源都取这三列，形状完全一致。 */
type UserRef = { id: string; nickname: string; avatarUrl: string | null; schoolId: string };

/**
 * 条目引用。`episode.subject` 与 `subject` 取的是同样四列，
 * 因此共用一个形状 —— 它们不同构时这里会立刻报错。
 */
type SubjectRef = { id: number; name: string; nameCn: string | null; coverUrl: string | null };

type CollectionRow = Prisma.CollectionGetPayload<{ include: typeof TIMELINE_INCLUDES.collection }>;
type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof TIMELINE_INCLUDES.review }>;
type DanmakuRow = Prisma.DanmakuGetPayload<{ include: typeof TIMELINE_INCLUDES.danmaku }>;
type ProgressRow = Prisma.EpisodeProgressGetPayload<{ include: typeof TIMELINE_INCLUDES.progress }>;
