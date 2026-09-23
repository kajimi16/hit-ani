/**
 * 弹幕源匹配链单测。
 *
 * 匹配是「借鉴公共弹幕源」的核心难点：同一部番在两个站的标题可能毫无共同点，
 * 集数编号还可能差一。这组测试把降级链的**优先级顺序**钉死 ——
 * 顺序错了会「匹配到别的番」，比匹配不上更糟（用户会看到完全无关的弹幕）。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MatchMethod,
  buildPrefixedEpisodeName,
  describeMatch,
  levenshteinDistance,
  matchEpisode,
  matchSubject,
  normalizeTitle,
  titlesMatch,
  type CandidateEpisode,
  type MatchRequest,
} from "@/lib/danmaku/matching";

function episode(overrides: Partial<CandidateEpisode> = {}): CandidateEpisode {
  return {
    episodeId: 1,
    subjectName: "コードギアス 反逆のルルーシュ",
    episodeName: "魔神 が 目覚める 日",
    episodeSort: 1,
    ...overrides,
  };
}

function request(overrides: Partial<MatchRequest> = {}): MatchRequest {
  return {
    subjectName: "反叛的鲁路修",
    subjectAliases: ["コードギアス 反逆のルルーシュ", "Code Geass"],
    episodeSort: 1,
    episodeEp: 1,
    episodeName: "魔王的苏醒之日",
    ...overrides,
  };
}

/* ---------------------------------------------------------------- *
 * Levenshtein
 * ---------------------------------------------------------------- */

test("levenshteinDistance 基础用例", () => {
  assert.equal(levenshteinDistance("", ""), 0);
  assert.equal(levenshteinDistance("abc", "abc"), 0);
  assert.equal(levenshteinDistance("", "abc"), 3);
  assert.equal(levenshteinDistance("abc", ""), 3);
  assert.equal(levenshteinDistance("kitten", "sitting"), 3);
  assert.equal(levenshteinDistance("abc", "abd"), 1);
});

test("levenshteinDistance 对称", () => {
  assert.equal(levenshteinDistance("abcde", "abx"), levenshteinDistance("abx", "abcde"));
});

test("levenshteinDistance 处理中日文与长串", () => {
  assert.equal(levenshteinDistance("反叛的鲁路修", "反叛的鲁鲁修"), 1);
  assert.ok(levenshteinDistance("コードギアス", "コードギアス 反逆") > 0);
});

/* ---------------------------------------------------------------- *
 * 归一化
 * ---------------------------------------------------------------- */

test("normalizeTitle 去空白/标点/大小写", () => {
  assert.equal(normalizeTitle("Code Geass"), "codegeass");
  assert.equal(normalizeTitle("CODE　GEASS"), "codegeass"); // 全角空格
  assert.equal(normalizeTitle("反叛的鲁路修！"), "反叛的鲁路修");
  assert.equal(normalizeTitle("ＡＢＣ"), "abc"); // 全角
});

test("titlesMatch 归一化后相等", () => {
  assert.equal(titlesMatch("Code Geass", "codegeass"), true);
  assert.equal(titlesMatch("反叛的鲁路修", "反叛的鲁路修"), true);
  assert.equal(titlesMatch("反叛的鲁路修", "反叛的鲁鲁修"), false);
  assert.equal(titlesMatch("", "abc"), false);
  assert.equal(titlesMatch("   ", "abc"), false);
});

/* ---------------------------------------------------------------- *
 * 降级链优先级（核心）
 * ---------------------------------------------------------------- */

test("第 1 级：sort 精确相等优先于一切", () => {
  const result = matchEpisode(request({ episodeSort: 5 }), [
    // 集名与请求更接近、但 sort 不对
    episode({ episodeId: 100, episodeSort: 1, episodeName: "魔王的苏醒之日" }),
    episode({ episodeId: 200, episodeSort: 5, episodeName: "完全不同的名字" }),
  ]);
  assert.equal(result.method, MatchMethod.ExactNumber);
  assert.equal(result.episode?.episodeId, 200);
});

test("第 2 级：sort 未命中时用 ep 命中", () => {
  const result = matchEpisode(request({ episodeSort: 99, episodeEp: 3 }), [
    episode({ episodeId: 300, episodeSort: 3 }),
  ]);
  assert.equal(result.method, MatchMethod.ExactNumber);
  assert.equal(result.episode?.episodeId, 300);
});

test("第 3 级：编号都不命中时用集名精确", () => {
  const result = matchEpisode(
    request({ episodeSort: 99, episodeEp: 98, episodeName: "魔王的苏醒之日" }),
    [episode({ episodeId: 400, episodeSort: 7, episodeName: "魔王的苏醒之日" })],
  );
  assert.equal(result.method, MatchMethod.ExactName);
  assert.equal(result.episode?.episodeId, 400);
});

test("第 3 级支持「第N话 <集名>」前缀变体", () => {
  // 真实场景：上游没给可用的集数编号（episodeSort 为 null），
  // 只能靠名字匹配，而上游集名常带「第N话 」前缀、本地集名不带。
  const result = matchEpisode(
    request({ episodeSort: 1, episodeEp: 1, episodeName: "魔王的苏醒之日" }),
    [episode({ episodeId: 500, episodeSort: null, episodeName: "第1话 魔王的苏醒之日" })],
  );
  assert.equal(result.method, MatchMethod.ExactName);
  assert.equal(result.episode?.episodeId, 500);
});

test("前缀变体的集号必须与请求一致，不能凭名字前缀蒙对", () => {
  // 请求是第 1 集，上游候选带「第7话」前缀 —— 不应按集名精确命中
  const result = matchEpisode(
    request({ episodeSort: 1, episodeEp: 1, episodeName: "魔王的苏醒之日" }),
    [episode({ episodeId: 501, episodeSort: null, episodeName: "第7话 魔王的苏醒之日" })],
  );
  assert.notEqual(result.method, MatchMethod.ExactName);
});

test("第 4 级：全部不精确时取距离最小者并标注 Fuzzy", () => {
  const result = matchEpisode(
    request({ episodeSort: 99, episodeEp: 98, episodeName: "魔王的苏醒之日" }),
    [
      episode({ episodeId: 600, episodeSort: 7, episodeName: "完全不相关的标题" }),
      episode({ episodeId: 700, episodeSort: 8, episodeName: "魔王的苏醒之日前篇" }),
    ],
  );
  assert.equal(result.method, MatchMethod.Fuzzy);
  assert.equal(result.episode?.episodeId, 700, "应选距离更近的那条");
  assert.ok(result.distance !== null && result.distance >= 0);
});

test("模糊匹配会与全部别名比较，而非只比主名", () => {
  const result = matchEpisode(
    request({
      // 主名与候选差异大
      subjectName: "反叛的鲁路修",
      // 别名与候选一致
      subjectAliases: ["コードギアス 反逆のルルーシュ"],
      episodeSort: 99,
      episodeEp: 98,
      episodeName: "同样不匹配的名字",
    }),
    [
      episode({ episodeId: 800, episodeSort: 1, episodeName: "同样不匹配的名字" }),
      episode({
        episodeId: 900,
        subjectName: "毫不相干的番剧名称",
        episodeSort: 2,
        episodeName: "同样不匹配的名字",
      }),
    ],
  );
  assert.equal(result.episode?.episodeId, 800, "别名完全一致的那条应胜出");
});

test("候选集为空返回 NoMatch", () => {
  const result = matchEpisode(request(), []);
  assert.equal(result.episode, null);
  assert.equal(result.method, MatchMethod.NoMatch);
  assert.equal(result.distance, null);
});

test("episodeSort 为 null 的候选不会误命中第 1 级", () => {
  const result = matchEpisode(request({ episodeSort: 1 }), [
    episode({ episodeId: 1, episodeSort: null, episodeName: "不同的名字" }),
  ]);
  // null 不应被当作等于 1
  assert.notEqual(result.method, MatchMethod.ExactNumber);
});

test("请求无集名时跳过第 3 级，直接走模糊", () => {
  const result = matchEpisode(
    request({ episodeSort: 99, episodeEp: 98, episodeName: "" }),
    [episode({ episodeId: 1, episodeSort: 5, episodeName: "任意" })],
  );
  assert.equal(result.method, MatchMethod.Fuzzy);
});

/* ---------------------------------------------------------------- *
 * 番剧级匹配
 * ---------------------------------------------------------------- */

test("matchSubject 按别名精确命中", () => {
  const list = [
    { animeTitle: "无关番剧" },
    { animeTitle: "コードギアス 反逆のルルーシュ" },
    { animeTitle: "另一部" },
  ];
  const hit = matchSubject(request(), list);
  assert.equal(hit?.animeTitle, "コードギアス 反逆のルルーシュ");
});

test("matchSubject 归一化后命中（大小写/空格差异）", () => {
  const hit = matchSubject(
    { subjectName: "Code Geass", subjectAliases: [] },
    [{ animeTitle: "CODE  GEASS" }],
  );
  assert.ok(hit);
});

test("matchSubject 无命中返回 null（不猜）", () => {
  const hit = matchSubject(request(), [{ animeTitle: "完全无关" }]);
  assert.equal(hit, null);
});

/* ---------------------------------------------------------------- *
 * 辅助
 * ---------------------------------------------------------------- */

test("buildPrefixedEpisodeName 用 ep 优先，回退 sort", () => {
  assert.equal(
    buildPrefixedEpisodeName(request({ episodeEp: 3, episodeSort: 1, episodeName: "X" })),
    "第3话 X",
  );
  assert.equal(
    buildPrefixedEpisodeName(request({ episodeEp: null, episodeSort: 5, episodeName: "X" })),
    "第5话 X",
  );
  assert.equal(buildPrefixedEpisodeName(request({ episodeName: "" })), null);
});

test("describeMatch 覆盖全部方法", () => {
  for (const method of Object.values(MatchMethod)) {
    assert.ok(describeMatch(method).length > 0, `${method} 缺少描述`);
  }
});
