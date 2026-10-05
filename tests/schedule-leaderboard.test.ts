/**
 * 排行榜排序测试。
 *
 * ## 防的是什么
 *
 * 排序错起来是**静默**的：榜单看起来只是「顺序有点怪」。
 * 两个具体风险：
 *
 * 1. **空值位置**。BGM 人数可能没取到（该条目还没进本地缓存），`null` 与
 *    「真的是 0 人」不是一回事。没有确定规则时，`null` 会混在中间，
 *    用户看到「0 人在看」排在有数据的条目之上，会以为数据错了。
 * 2. **并列时的次序**。同一热度的一批条目若没有收尾键，数据库不保证稳定序，
 *    榜单每次刷新都会自己抖动。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LEADERBOARD_SORT,
  LEADERBOARD_SORTS,
  isLeaderboardSort,
  rankLeaderboard,
  type LeaderboardEntry,
} from "@/lib/schedule-leaderboard";

const entry = (over: Partial<LeaderboardEntry> & { subjectId: number }): LeaderboardEntry => ({
  title: `条目 ${over.subjectId}`,
  coverUrl: null,
  bgmScore: null,
  bgmDoing: null,
  schoolDoing: 0,
  schoolAvgRating: null,
  schoolRatedCount: 0,
  ...over,
});

test("按 BGM 在看人数降序", () => {
  const ranked = rankLeaderboard(
    [
      entry({ subjectId: 1, bgmDoing: 100 }),
      entry({ subjectId: 2, bgmDoing: 900 }),
      entry({ subjectId: 3, bgmDoing: 500 }),
    ],
    "bgm-doing",
  );
  assert.deepEqual(ranked.map((e) => e.subjectId), [2, 3, 1]);
});

test("BGM 人数没取到的排最后，而不是当成 0 混在中间", () => {
  // `null` 是「我们还没有这个数据」，不是「没人看」。混在中间会让用户
  // 以为数据错了。
  const ranked = rankLeaderboard(
    [
      entry({ subjectId: 1, bgmDoing: null }),
      entry({ subjectId: 2, bgmDoing: 0 }), // 真的是 0（BGM 说没人看）
      entry({ subjectId: 3, bgmDoing: 50 }),
    ],
    "bgm-doing",
  );
  // 50 > 0 > null
  assert.deepEqual(ranked.map((e) => e.subjectId), [3, 2, 1]);
});

test("全部为 null 时不抛错，退化成按 id 稳定排序", () => {
  // 用 `-Infinity` 当哨兵会让 `-Infinity - (-Infinity)` 变成 NaN，
  // 比较函数行为未定义。这里验证那个坑没有踩到。
  const ranked = rankLeaderboard(
    [entry({ subjectId: 9 }), entry({ subjectId: 3 }), entry({ subjectId: 5 })],
    "bgm-doing",
  );
  assert.deepEqual(ranked.map((e) => e.subjectId), [3, 5, 9]);
});

test("并列时以 id 收尾 —— 否则榜单每次刷新都抖动", () => {
  const same = [entry({ subjectId: 7, bgmDoing: 100 }), entry({ subjectId: 2, bgmDoing: 100 }), entry({ subjectId: 5, bgmDoing: 100 })];
  const first = rankLeaderboard(same, "bgm-doing").map((e) => e.subjectId);
  const second = rankLeaderboard([...same].reverse(), "bgm-doing").map((e) => e.subjectId);
  assert.deepEqual(first, [2, 5, 7]);
  assert.deepEqual(first, second, "输入顺序变了结果就变了");
});

test("校内在看排序：0 是真实值，参与比较", () => {
  // 与 BGM 人数不同，校内在看人数是我们自己的统计，0 就是「本校没人看」，
  // 不该被当成「没数据」排到最后。
  const ranked = rankLeaderboard(
    [
      entry({ subjectId: 1, schoolDoing: 0 }),
      entry({ subjectId: 2, schoolDoing: 5 }),
      entry({ subjectId: 3, schoolDoing: 2 }),
    ],
    "school-doing",
  );
  assert.deepEqual(ranked.map((e) => e.subjectId), [2, 3, 1]);
});

test("评分排序：校内均分优先，没有校内评分时退到 BGM 评分", () => {
  const ranked = rankLeaderboard(
    [
      entry({ subjectId: 1, schoolAvgRating: null, bgmScore: 9.5 }), // 只看 BGM
      entry({ subjectId: 2, schoolAvgRating: 8.0, bgmScore: 6.0 }), // 校内均分高
      entry({ subjectId: 3, schoolAvgRating: null, bgmScore: 7.0 }),
    ],
    "score",
  );
  // 2 有校内均分 8.0 排第一；1 的 BGM 9.5 > 3 的 7.0
  assert.deepEqual(ranked.map((e) => e.subjectId), [2, 1, 3]);
});

test("非法排序值退回默认，不抛错", () => {
  assert.equal(DEFAULT_LEADERBOARD_SORT, "bgm-doing");
  for (const option of LEADERBOARD_SORTS) {
    assert.equal(isLeaderboardSort(option.value), true);
  }
  for (const bad of ["", "BGMS", "newest", undefined, null, 1]) {
    assert.equal(isLeaderboardSort(bad), false);
  }
});

test("不改动入参数组（避免调用方拿到被就地排序的列表）", () => {
  const input = [entry({ subjectId: 1, bgmDoing: 1 }), entry({ subjectId: 2, bgmDoing: 2 })];
  const copy = [...input];
  rankLeaderboard(input, "bgm-doing");
  assert.deepEqual(input.map((e) => e.subjectId), copy.map((e) => e.subjectId));
});

test("空输入返回空数组", () => {
  for (const option of LEADERBOARD_SORTS) {
    assert.deepEqual(rankLeaderboard([], option.value), []);
  }
});

test("每种排序都产出确定顺序（两次调用结果一致）", () => {
  const entries = [
    entry({ subjectId: 1, bgmDoing: 10, schoolDoing: 1, bgmScore: 7, schoolAvgRating: 8 }),
    entry({ subjectId: 2, bgmDoing: 10, schoolDoing: 1, bgmScore: 7, schoolAvgRating: 8 }),
    entry({ subjectId: 3, bgmDoing: 10, schoolDoing: 1, bgmScore: 7, schoolAvgRating: 8 }),
  ];
  for (const option of LEADERBOARD_SORTS) {
    const a = rankLeaderboard(entries, option.value).map((e) => e.subjectId);
    const b = rankLeaderboard([...entries].reverse(), option.value).map((e) => e.subjectId);
    assert.deepEqual(a, b, `${option.value} 的顺序不稳定`);
  }
});
