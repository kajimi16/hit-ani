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
    // 上游已按热度排序，前几个就是最相关的标签
    tags: (detail.tags ?? []).map((tag) => tag.name),
  };
}

/**
 * 收藏列表内嵌的 `SlimSubject` 能提供的字段。
 *
 * 比详情少得多：没有完整简介、没有评分分布、没有标签计数 —— 这些要等
 * 用户真正打开条目时由详情接口补。因此它**不覆盖**已有数据，
 * 尤其是不能把 `ratingTotal` / `ratingHistogram` 写成 null。
 */
export function subjectFieldsFromSlim(subject: {
  type?: number;
  name: string;
  name_cn?: string;
  short_summary?: string;
  images?: { large?: string; common?: string; medium?: string };
  score?: number;
  rank?: number;
  tags?: { name: string }[];
}): Omit<SubjectFields, "airDate" | "ratingTotal" | "ratingHistogram"> & { tags: string[] } {
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
  };
}
