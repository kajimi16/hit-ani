/**
 * Bangumi 条目 → 本地 `Subject` 列的映射。
 *
 * ## 为什么单独成模块
 *
 * 项目里有**两处**会从上游条目详情写 `Subject`：`enrichSubject`（打开条目页时
 * 补齐）与 `src/app/api/subjects/[id]/route.ts`。此前两处各写一份字段对象，
 * 于是字段清单必然漂移 —— 实际就漂了：
 *
 * - 一处漏了 `rank`，另一处漏了 `ratingTotal` / `ratingHistogram`；
 * - 漏键在 Prisma 的对象字面量里**不是类型错误**，`tsc` 一声不响；
 * - 症状是详情页右栏的「排名」「N 人评分」「评分直方图」在**某些条目上**
 *   是空的 —— 而哪些条目取决于它是被哪条路径缓存的，极难复现。
 *
 * 现在两处都调这个函数，并且有测试逐字段断言「详情里有的都必须被带走」，
 * 新增列时漏写会立刻失败。
 */

import { parseIsoDate } from "@/lib/date";
import type { Subject } from "@/lib/bgm/client";
import type { Prisma } from "@prisma/client";


/**
 * 详情接口能提供的全部 `Subject` 字段。
 *
 * 返回类型显式写出（而不是让 TS 推断）是为了让「新增列必须在这里补」成为
 * 一个会被编译器看见的动作：加了列就改这里的类型，漏了就编译不过。
 */
export interface SubjectFields {
  type: number;
  name: string;
  nameCn: string | null;
  summary: string | null;
  coverUrl: string | null;
  airDate: Date | null;
  score: number | null;
  rank: number | null;
  ratingTotal: number | null;
  ratingHistogram: Prisma.InputJsonValue | undefined;
  /**
   * Bangumi 全站的收藏人数。
   *
   * 可空：老响应可能没有 `collection` 字段；用 `null` 而不是 `0`，
   * 才能区分「BGM 说没人收藏」与「我们没拿到这个数」。
   */
  bgmWish: number | null;
  bgmDoing: number | null;
  bgmDone: number | null;
  bgmOnHold: number | null;
  bgmDropped: number | null;
  tags: string[];
}

/**
 * 把条目详情映射成可写入的列。
 *
 * 两处细节值得说明：
 *
 * 1. `ratingHistogram` 用 `undefined` 而不是 `null`。Prisma 的可空 Json 列
 *    不接受裸 `null`，而「不传这个键」就是「不写这一列」，语义正好。
 * 2. **所有键都显式写出**，包括取值为 null 的。这是刻意的：让「上游没给」
 *    与「我们忘了映射」在代码里长得不一样 —— 后者会是缺键，而缺键正是
 *    这次出问题的形态。
 */
export function subjectFieldsFromDetail(detail: Subject): SubjectFields {
  return {
    type: detail.type,
    name: detail.name,
    nameCn: detail.name_cn || null,
    summary: detail.summary || null,
    coverUrl: detail.images?.large ?? detail.images?.common ?? null,
    airDate: parseIsoDate(detail.date),
    score: detail.rating?.score ?? null,
    rank: detail.rating?.rank ?? null,
    // 右栏「N 人评分」与左栏作品信息都要用
    ratingTotal: detail.rating?.total ?? null,
    // 1–10 分分布。只为展示，且键固定，因此存 Json 而不单独建表。
    ratingHistogram: detail.rating?.count ?? undefined,
    /*
     * BGM 全站的收藏人数。
     *
     * `?? null` 而不是 `?? 0`：拿不到与「确实是 0 人」必须能区分 ——
     * 显示成「0 人在看」会让人以为这部番没人看，而真相是我们没取到数据。
     */
    bgmWish: detail.collection?.wish ?? null,
    bgmDoing: detail.collection?.doing ?? null,
    // BGM 叫 `collect`，本项目统一叫「看过」（Done）
    bgmDone: detail.collection?.collect ?? null,
    bgmOnHold: detail.collection?.on_hold ?? null,
    bgmDropped: detail.collection?.dropped ?? null,
    // 上游已按热度排序，前几个就是最相关的标签
    tags: (detail.tags ?? []).map((tag) => tag.name),
  };
}

/**
 * 收藏列表内嵌的 `SlimSubject` 能提供的字段。
 *
 * 比详情少一些：没有完整简介、没有评分分布 —— 这些要等用户真正打开条目时
 * 由详情接口补。但它**确实提供 `date`**（`SlimSubject.date`，规范里标注为
 * `air date in YYYY-MM-DD format`），实测收藏接口 8/8 都带上了。
 *
 * ## 两条相反的约束，决定了这个函数的形状
 *
 * 1. **不能漏字段**：漏掉 `date` 会让「导入过但没打开过」的条目在作品信息里
 *    显示「未定档」，直到用户点进去才补上（实测有 9 个这样的条目）。
 * 2. **不能覆盖已有数据**：返回值作为 `update: fields` 在**每次重新导入收藏**
 *    时整体写入，多带一个 `null` 就会把值抹掉。
 *
 * `date` 在规范里是**可选**的，所以无条件写 `airDate: parseIsoDate(date)`
 * 会同时踩中第 2 条：某个条目这次没带 `date`，就会把详情接口已经取到的首播
 * 日期清空。因此 `airDate` 是一个**条件键** —— 只有真的解析出日期时才出现，
 * 否则整个键缺席，Prisma 便不会碰这一列。
 *
 * 同理，`ratingTotal` / `ratingHistogram` / `bgm*` 这些**永远不出现**：
 * `SlimSubject` 里既没有评分分布也没有全站收藏人数，带上它们等于每次导入都
 * 清空一次右栏的「N 人评分」、直方图与「在看人数」。
 *
 * 这条约束由类型强制：`SlimSubjectFields` 用 `Omit` 把这些键去掉，
 * 漏掉一个就编译不过（实测确实因此报错过一次）。
 */
export type SlimSubjectFields = Omit<
  SubjectFields,
  // `SlimSubject` 里没有这些 —— 详情接口才提供
  | "airDate"
  | "ratingTotal"
  | "ratingHistogram"
  | "bgmWish"
  | "bgmDoing"
  | "bgmDone"
  | "bgmOnHold"
  | "bgmDropped"
> & {
  /** **条件键**：上游给了可解析的日期时才有，否则缺席（而不是 null）。 */
  airDate?: Date;
};

export function subjectFieldsFromSlim(subject: {
  type?: number;
  name: string;
  name_cn?: string;
  short_summary?: string;
  date?: string;
  images?: { large?: string; common?: string; medium?: string };
  score?: number;
  rank?: number;
  tags?: { name: string }[];
}): SlimSubjectFields {
  const airDate = parseIsoDate(subject.date);

  return {
    type: subject.type ?? 2,
    name: subject.name,
    nameCn: subject.name_cn || null,
    // SlimSubject 给的是截短简介；完整简介等 enrichSubject
    summary: subject.short_summary || null,
    coverUrl: subject.images?.large ?? subject.images?.common ?? null,
    score: subject.score || null,
    rank: subject.rank || null,
    tags: (subject.tags ?? []).map((tag) => tag.name),
    // 条件展开：没有日期时这个键根本不存在，`update` 便不会清空已有值
    ...(airDate ? { airDate } : {}),
  };
}
