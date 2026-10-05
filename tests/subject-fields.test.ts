/**
 * 条目字段映射测试。
 *
 * ## 防的是什么
 *
 * `Subject` 的列由**两处**从上游写入：`enrichSubject`（打开条目页时补齐）与
 * `api/subjects/[id]`。此前两处各写一份字段对象，于是清单漂了 —— 而且**漏的
 * 字段还不一样**：一处漏 `rank`，另一处漏 `ratingTotal` / `ratingHistogram`。
 *
 * 漏键在 Prisma 的对象字面量里不是类型错误，`tsc` 一声不响；症状是详情页右栏
 * 的「排名」「N 人评分」「评分直方图」在**某些条目上**为空 —— 哪些条目取决于
 * 它被哪条路径缓存，极难复现。
 *
 * 这组断言把「详情里有的都必须被带走」变成可执行的检查：以后新增列时漏写，
 * 会立刻在这里失败。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { subjectFieldsFromDetail, subjectFieldsFromSlim } from "@/lib/bgm/subject-fields";
import { parseIsoDate } from "@/lib/date";
import type { Subject } from "@/lib/bgm/client";

/** 与真实响应同形状的最小条目（字段值取自条目 493016）。 */
function detail(overrides: Partial<Subject> = {}): Subject {
  return {
    id: 493016,
    type: 2,
    name: "異国日記",
    name_cn: "异国日记",
    summary: "简介正文",
    date: "2026-01-04",
    images: { large: "https://lain.bgm.tv/large.jpg", common: "https://lain.bgm.tv/common.jpg" },
    rating: {
      rank: 66,
      total: 8037,
      count: { "1": 21, "7": 921, "8": 2708, "9": 3111, "10": 982 },
      score: 8.4,
    },
    tags: [
      { name: "治愈", count: 1897 },
      { name: "漫画改", count: 1701 },
    ],
    ...overrides,
  } as Subject;
}

test("详情里的每个可展示字段都被带走 —— 漏一个就失败", () => {
  const fields = subjectFieldsFromDetail(detail());

  // 逐项断言，而不是只测几个。漏掉某个键会让对应 UI 静默变空，
  // 这正是这次出问题的形态。
  assert.equal(fields.type, 2);
  assert.equal(fields.name, "異国日記");
  assert.equal(fields.nameCn, "异国日记");
  assert.equal(fields.summary, "简介正文");
  assert.equal(fields.coverUrl, "https://lain.bgm.tv/large.jpg");
  assert.equal(fields.score, 8.4);
  assert.equal(fields.rank, 66, "排名缺失会让详情页「排名」为空");
  assert.equal(fields.ratingTotal, 8037, "评分人数缺失会让「N 人评分」为空");
  assert.deepEqual(fields.tags, ["治愈", "漫画改"], "标签缺失会让标签板块整块消失");
});

test("评分直方图必须被带走（右栏的评分分布靠它）", () => {
  const fields = subjectFieldsFromDetail(detail());
  assert.deepEqual(fields.ratingHistogram, { "1": 21, "7": 921, "8": 2708, "9": 3111, "10": 982 });
});

test("airDate 被解析成 Date，而不是把字符串直接塞进 DateTime 列", () => {
  const fields = subjectFieldsFromDetail(detail());
  assert.ok(fields.airDate instanceof Date);
  assert.equal(fields.airDate!.toISOString().slice(0, 10), "2026-01-04");
});

test("上游缺字段时落 null，而不是 undefined 或 NaN", () => {
  // `rating` 整个缺失是常见情况（未定档 / 冷门条目）。
  const fields = subjectFieldsFromDetail(detail({ rating: undefined, tags: undefined, date: undefined }));
  assert.equal(fields.score, null);
  assert.equal(fields.rank, null);
  assert.equal(fields.ratingTotal, null);
  assert.equal(fields.airDate, null);
  assert.deepEqual(fields.tags, []);
  // 直方图用 undefined：Prisma 的可空 Json 列不接受裸 null
  assert.equal(fields.ratingHistogram, undefined);
});

test("空的 rating.count 不会被当成 undefined 丢掉", () => {
  // 区分「上游给了空直方图」与「上游没给」：前者是 {}，后者是 undefined。
  const fields = subjectFieldsFromDetail(detail({ rating: { rank: 1, total: 0, count: {}, score: 0 } as never }));
  assert.deepEqual(fields.ratingHistogram, {});
});

test("parseIsoDate 只接受严格的 YYYY-MM-DD", () => {
  assert.equal(parseIsoDate("2026-01-04")!.toISOString().slice(0, 10), "2026-01-04");
  // BGM 对未定档条目会返回空串
  for (const bad of ["", "  ", "2026-1-4", "2026/01/04", "2026-13-45", "未定档", null, undefined]) {
    assert.equal(parseIsoDate(bad as string), null, `${JSON.stringify(bad)} 应解析为 null`);
  }
});

test("parseIsoDate 用 UTC，不受本地时区影响", () => {
  // 用本地时间构造会让 UTC+8 的机器把 2026-01-04 存成 2026-01-03。
  const date = parseIsoDate("2026-01-04")!;
  assert.equal(date.getUTCFullYear(), 2026);
  assert.equal(date.getUTCMonth(), 0);
  assert.equal(date.getUTCDate(), 4);
  assert.equal(date.getUTCHours(), 0);
});

/* ---------------------------------------------------------------- *
 * 轻量映射：**键集**本身就是不变量
 * ---------------------------------------------------------------- */

/**
 * `subjectFieldsFromSlim` 的返回值会被当作 `update: fields` 在**每次重新导入
 * 收藏时**整体写入 —— 因此它多带一个键，就意味着一列被清空。
 *
 * `SlimSubject` 里没有评分人数与评分分布，若哪天有人「顺手补齐」把这两个键
 * 加上（或把实现改成复用 `subjectFieldsFromDetail`），那么每次重跑导入都会把
 * 已存的 `ratingTotal` / `ratingHistogram` 覆盖成 `null` —— 详情页右栏的
 * 「N 人评分」与直方图会**在全站范围内**消失，而没有任何测试会失败。
 *
 * 所以这里断言的是**键集**，不是取值：漏键与多键都要能被抓住。
 * 用 `Object.keys` 而不是逐项取值，因为「多了一个不该有的键」正是要防的形态。
 */
test("轻量映射绝不携带评分人数与评分直方图", () => {
  const fields = subjectFieldsFromSlim({
    name: "异国日记",
    name_cn: "异国日记",
    short_summary: "截短简介",
    images: { common: "https://lain.bgm.tv/c.jpg" },
    score: 8.4,
    rank: 66,
    tags: [{ name: "治愈" }],
  });

  const keys = Object.keys(fields);
  assert.equal(
    keys.includes("ratingTotal"),
    false,
    "带上 ratingTotal 会在每次重新导入收藏时把它清空",
  );
  assert.equal(
    keys.includes("ratingHistogram"),
    false,
    "带上 ratingHistogram 会在每次重新导入收藏时把它清空",
  );
  // 同理：`airDate` 也不该出现在轻量路径 —— SlimSubject 没有日期字段，
  // 带上它只会把已有的首播日期写成 null。
  assert.equal(keys.includes("airDate"), false, "SlimSubject 没有日期，不该带 airDate");
});

test("轻量映射的键集与「不覆盖」的承诺一致", () => {
  // 把允许的键写死，任何人新增键都要先想清楚「这会不会清空已有数据」。
  const allowed = ["type", "name", "nameCn", "summary", "coverUrl", "score", "rank", "tags"];
  const keys = Object.keys(subjectFieldsFromSlim({ name: "x" })).sort();
  assert.deepEqual(keys, [...allowed].sort());
});

test("轻量映射对缺失的可选字段给 null / 空数组，不抛错", () => {
  const fields = subjectFieldsFromSlim({ name: "只有名字" });
  assert.equal(fields.nameCn, null);
  assert.equal(fields.summary, null);
  assert.equal(fields.coverUrl, null);
  assert.equal(fields.score, null);
  assert.equal(fields.rank, null);
  assert.deepEqual(fields.tags, []);
});

test("轻量映射优先用大图，退化到 common", () => {
  assert.equal(
    subjectFieldsFromSlim({ name: "x", images: { large: "L", common: "C" } }).coverUrl,
    "L",
  );
  assert.equal(subjectFieldsFromSlim({ name: "x", images: { common: "C" } }).coverUrl, "C");
});
