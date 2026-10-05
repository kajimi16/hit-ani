/**
 * 追番页的排序映射。
 *
 * ## 为什么单独成模块并测试
 *
 * 排序写错**不会报错**，只会让顺序看起来「没生效」或「不稳定」—— 用户看到的是
 * 「我选了按评分排，但列表没变」，没有任何日志能帮你定位。而这里有两个容易踩的点：
 *
 * 1. **并列时的次序**。只按 `score` 排，同一评分的几十条每次查询顺序都可能不同，
 *    翻页时还会重复或漏条。因此每个排序都以主键收尾，保证全序。
 * 2. **空值位置**。`collectedAt` 与 `rating` 都可空（站内手动收藏没有上游时间、
 *    未评分时为 null）。Postgres 默认 `DESC` 把 NULL 排在最前 —— 于是「按我的评分
 *    排序」会把一堆未评分的顶到最上面。必须显式 `nulls: "last"`。
 */

import type { Prisma } from "@prisma/client";
import type { LibrarySort } from "@/lib/library-query";

/**
 * 排序方式 → Prisma `orderBy`。
 *
 * 返回 `CollectionOrderByWithRelationInput[]`：数组形式才能表达「主键 + 并列次序」，
 * 对象形式只接受单个键。
 */
export function collectionOrderBy(
  sort: LibrarySort,
): Prisma.CollectionOrderByWithRelationInput[] {
  switch (sort) {
    case "collected":
      // 「加入收藏时间」降序（最近加入的在前）。
      // 用 collectedAt 而不是 updatedAt —— 后者是 Prisma 自动维护的本地修改时间，
      // 改一次评分就会刷新，于是「按加入时间排序」会变成「按最近动过排序」。
      return [
        { collectedAt: { sort: "desc", nulls: "last" } },
        // 并列时用 updatedAt 而不是 id：同一批导入的条目 collectedAt 常常相同
        // （BGM 的时间戳精度只到秒），此时「最近动过」比随机的主键更有意义。
        { updatedAt: "desc" },
        { id: "asc" },
      ];

    case "myrating":
      // 未评分的排最后，否则一屏全是「未评分」
      return [
        { rating: { sort: "desc", nulls: "last" } },
        { updatedAt: "desc" },
        { id: "asc" },
      ];

    case "score":
      // 关联表的字段排序；未在 BGM 上架/无评分的条目排最后
      return [
        { subject: { score: { sort: "desc", nulls: "last" } } },
        { updatedAt: "desc" },
        { id: "asc" },
      ];

    case "recent":
    default:
      return [{ updatedAt: "desc" }, { id: "asc" }];
  }
}

/** 排序是否依赖 `collectedAt` —— 决定要不要提示用户「部分条目时间未知」。 */
export function sortUsesCollectedAt(sort: LibrarySort): boolean {
  return sort === "collected";
}
