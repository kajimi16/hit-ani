/**
 * 新番排行榜的排序与聚合。
 *
 * 抽成纯函数有两个理由：
 * 1. **排序要稳定**。同分/同人数的条目若没有收尾次序，每次请求顺序都可能不同，
 *    榜单看起来会「自己抖动」。
 * 2. **空值的语义**要写清楚：BGM 人数可能没取到（本地缓存里没有该条目），
 *    校内在看人数可能真的是 0。两者在界面上必须能区分，排序时也要有确定的
 *    位置，不能随机混在中间。
 */

export interface LeaderboardEntry {
  subjectId: number;
  title: string;
  coverUrl: string | null;
  /** BGM 评分（10 分制）；null = 上游没给 */
  bgmScore: number | null;
  /** BGM 在看人数；null = 本地还没有这个条目的数据（**不是** 0） */
  bgmDoing: number | null;
  /** 本校本条目的「在看」人数（0 是真实值） */
  schoolDoing: number;
  /** 校内平均评分（10 分制，保留一位）；null = 本校还没有人评分 */
  schoolAvgRating: number | null;
  /** 参与评分的本校人数，用于说明平均分的样本量 */
  schoolRatedCount: number;
}

/** 排序方式。 */
export const LEADERBOARD_SORTS = [
  { value: "bgm-doing", label: "BGM 在看" },
  { value: "school-doing", label: "校内在看" },
  { value: "score", label: "评分" },
] as const;

export type LeaderboardSort = (typeof LEADERBOARD_SORTS)[number]["value"];

export const DEFAULT_LEADERBOARD_SORT: LeaderboardSort = "bgm-doing";

export function isLeaderboardSort(value: unknown): value is LeaderboardSort {
  return typeof value === "string" && LEADERBOARD_SORTS.some((o) => o.value === value);
}

/**
 * 取数值用于比较，`null` 一律排到最后。
 *
 * 用一个足够小的哨兵值而不是 `-Infinity`：`-Infinity - (-Infinity)` 是 `NaN`，
 * 会让 `sort` 的比较函数行为未定义。用 `-1` 即可 —— 所有真实值都 ≥ 0。
 */
function comparable(value: number | null): number {
  return value ?? -1;
}

/**
 * 排序并编号。
 *
 * 每个排序键之后都跟 `subjectId` 收尾 —— 没有它，同一热度的一批条目顺序
 * 每次请求都可能不同（数据库不保证稳定序），榜单会自己抖动。
 */
export function rankLeaderboard(
  entries: LeaderboardEntry[],
  sort: LeaderboardSort,
): LeaderboardEntry[] {
  const byKey = (a: LeaderboardEntry, b: LeaderboardEntry): number => {
    switch (sort) {
      case "school-doing":
        // 校内在看人数是站内真实值，0 也参与比较（那是真的没人看）
        return b.schoolDoing - a.schoolDoing;
      case "score":
        // 校内有评分的优先按校内平均分；没有评分的退到 BGM 评分
        return (
          comparable(b.schoolAvgRating) - comparable(a.schoolAvgRating) ||
          comparable(b.bgmScore) - comparable(a.bgmScore)
        );
      case "bgm-doing":
      default:
        return comparable(b.bgmDoing) - comparable(a.bgmDoing);
    }
  };

  return [...entries].sort((a, b) => byKey(a, b) || a.subjectId - b.subjectId);
}
