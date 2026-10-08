import { SubjectType } from "@/lib/bgm/client";
import { STUB_SUBJECT_ID_MIN } from "@/lib/subject-ids";
import { prisma } from "@/lib/prisma";

/**
 * 排行榜的取数逻辑。
 *
 * 抽出来**不是为了复用**，是为了**能被测试**：这段 where 里两条过滤都对应
 * 真实的线上事故，而它们写在页面组件里就只能靠肉眼保证。
 *
 * 1. **测试桩混入** —— 桩条目的 `rank` 是造的假值（`100 + index`），
 *    早期用 `900000` 基址写的桩在改成 `800000` 后再没人清理，
 *    结果榜首长期被「桩条目 900010」占据。
 * 2. **`rank = 0` 的条目** —— BGM 对「暂无排名」的条目给 `0` 而不是省略字段。
 *    只判断 `rank != null` 会让它们排在最前面（0 比任何真实名次都小）。
 */

/** 每页条目数。50 条足够一屏扫完，又不至于让查询变慢。 */
export const RANKING_PAGE_SIZE = 50;

export interface RankingFilters {
  /** `"all"` 表示不筛类型。 */
  type: string;
  /** 从 1 开始的页码。 */
  page: number;
}

/**
 * 排行查询的 where。
 *
 * 导出以便测试直接断言「桩与 rank=0 被排除」，而不用把页面渲染出来。
 */
export function rankingWhere(type: string) {
  return {
    rank: { gt: 0 },
    id: { lt: STUB_SUBJECT_ID_MIN },
    ...(type === "all" ? {} : { type: Number(type) }),
  };
}

/** 读取一页排行榜数据。 */
export async function listRanking({ type, page }: RankingFilters) {
  const where = rankingWhere(type);

  /*
   * `rank` 是可空列，**必须显式 `nulls`** —— Postgres 在 `ASC` 下默认把
   * NULL 排在最前，那会让「暂无排名」的条目顶到榜首。虽然上面的 where
   * 已把 `rank <= 0` 排除、null 进不来，但显式写出来既符合本仓库约定
   * （`tests/null-ordering.test.ts` 会扫），也让将来放宽 where 时不会
   * 静默踩坑。第二键 `id` 是必填列，不需要 `nulls`，作用是保证分页稳定。
   */
  const orderBy = [{ rank: { sort: "asc" as const, nulls: "last" as const } }, { id: "asc" as const }];

  const [total, subjects] = await Promise.all([
    prisma.subject.count({ where }),
    prisma.subject.findMany({
      where,
      orderBy,
      skip: (page - 1) * RANKING_PAGE_SIZE,
      take: RANKING_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        nameCn: true,
        coverUrl: true,
        score: true,
        rank: true,
        ratingTotal: true,
      },
    }),
  ]);

  return { total, subjects, lastPage: Math.max(1, Math.ceil(total / RANKING_PAGE_SIZE)) };
}

/**
 * 页面上可选类型（值 → 文案）。第一项是默认值。
 *
 * 用 `SubjectType` 枚举而不是字面量 —— `1/2/3/4/6` 这种数字在本仓库
 * 已经因为「跨项目取值混用」出过静默失效（弹幕的位置码）。
 */
export const RANKING_TYPES = [
  { value: String(SubjectType.Anime), label: "动画" },
  { value: String(SubjectType.Book), label: "书籍" },
  { value: String(SubjectType.Game), label: "游戏" },
  { value: String(SubjectType.Real), label: "三次元" },
  { value: "all", label: "全部" },
] as const;

export const DEFAULT_RANKING_TYPE = String(SubjectType.Anime);
