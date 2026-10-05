/**
 * 时光机的归一化测试。
 *
 * ## 防的是什么
 *
 * 四个来源（收藏 / 评论 / 弹幕 / 进度）的行形状完全不同，要合成一条按时间
 * 排序的流。这段映射错起来是**静默**的：
 * - 漏掉一个来源 → 时光机里少一整类活动，没有任何报错；
 * - 弹幕挂在章节上、条目要从 `episode.subject` 再上一层取 → 取错就全是
 *   「条目 ?」；
 * - 并列时间不设收尾次序 → 批量导入产生的同秒事件顺序随机，翻页重复或漏条。
 *
 * 因此这里逐类断言，而不是只测「返回了非空数组」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, excerpt, foldProgress, PROGRESS_LABELS } from "@/lib/timeline/types";

const user = { id: "u1", nickname: "卡基米", avatarUrl: null, schoolId: "hit" };
const subject = { id: 493016, name: "異国日記", nameCn: "异国日记", coverUrl: "https://x/c.jpg" };
const at = (iso: string) => new Date(iso);

/*
 * 行工厂。
 *
 * `buildTimeline` 的入参类型由 Prisma 的 `GetPayload` 派生、包含全部标量列 ——
 * 这是刻意的（查询里字段名写错会编译失败）。但测试只关心被映射用到的字段，
 * 因此这里补上其余标量的占位值，让用例本身保持可读。
 */
const collectionRow = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  userId: "u1",
  subjectId: 493016,
  type: 1,
  comment: null as string | null,
  rating: null as number | null,
  source: "bgm",
  isPrivate: false,
  updatedAt: at("2026-01-01T00:00:00Z"),
  collectedAt: null as Date | null,
  user,
  subject,
  ...over,
});

const reviewRow = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  userId: "u1",
  subjectId: 493016,
  kind: 0,
  title: null as string | null,
  content: "",
  rating: null as number | null,
  schoolId: "hit",
  likes: 0,
  createdAt: at("2026-01-01T00:00:00Z"),
  updatedAt: at("2026-01-01T00:00:00Z"),
  user,
  subject,
  ...over,
});

const danmakuRow = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  userId: "u1",
  schoolId: "hit",
  episodeId: 1,
  playTimeMs: 0,
  text: "",
  color: 16777215,
  location: 0,
  status: 0,
  serviceId: "HitAni",
  createdAt: at("2026-01-01T00:00:00Z"),
  user,
  episode: { ep: 1, sort: 1, subject },
  ...over,
});

const progressRow = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  userId: "u1",
  episodeId: 1,
  type: 2,
  updatedAt: at("2026-01-01T00:00:00Z"),
  user,
  episode: { ep: 1, sort: 1, subject },
  ...over,
});

const empty = { collections: [], reviews: [], danmakus: [], progress: [] };

test("四类活动都能被归一化，一个都不能漏", () => {
  const events = buildTimeline({
    collections: [collectionRow({ id: "c1", type: 3, rating: 8, comment: "好看", collectedAt: at("2026-01-04T00:00:00Z") })],
    reviews: [reviewRow({ id: "r1", content: "短评正文", rating: 7, createdAt: at("2026-01-03T00:00:00Z") })],
    danmakus: [danmakuRow({ id: "d1", text: "前方高能", createdAt: at("2026-01-02T00:00:00Z") })],
    progress: [progressRow({ id: "p1", type: 2, updatedAt: at("2026-01-01T00:00:00Z") })],
  });

  assert.equal(events.length, 4, "有来源被漏掉了");
  assert.deepEqual(
    [...new Set(events.map((e) => e.kind))].sort(),
    ["collection", "danmaku", "progress", "review"],
  );
});

test("按时间倒序排列", () => {
  const events = buildTimeline({
    ...empty,
    collections: [
      collectionRow({ id: "c1", collectedAt: at("2026-01-01T00:00:00Z") }),
      collectionRow({ id: "c2", collectedAt: at("2026-03-01T00:00:00Z") }),
    ],
  });
  assert.deepEqual(events.map((e) => e.id), ["collection:c2", "collection:c1"]);
});

test("时间相同时以 id 收尾 —— 否则翻页会重复或漏条", () => {
  // 批量导入产生的收藏常常是同一秒，只按时间排会让顺序随机。
  const same = at("2026-01-01T00:00:00Z");
  const events = buildTimeline({
    ...empty,
    collections: [
      collectionRow({ id: "z9", collectedAt: same }),
      collectionRow({ id: "a1", collectedAt: same }),
      collectionRow({ id: "m5", collectedAt: same }),
    ],
  });
  assert.deepEqual(events.map((e) => e.id), ["collection:a1", "collection:m5", "collection:z9"]);

  // 输入顺序变了，结果必须一致
  const again = buildTimeline({
    ...empty,
    collections: [
      collectionRow({ id: "m5", collectedAt: same }),
      collectionRow({ id: "z9", collectedAt: same }),
      collectionRow({ id: "a1", collectedAt: same }),
    ],
  });
  assert.deepEqual(again.map((e) => e.id), events.map((e) => e.id), "输入顺序变了结果就变了");
});

test("弹幕与进度从章节再上一层取到条目 —— 否则会显示占位文本", () => {
  // 弹幕行只有 `episode`，条目在 `episode.subject` 上。取错层就全成了「条目 ?」。
  const events = buildTimeline({
    ...empty,
    danmakus: [danmakuRow({ id: "d1" })],
    progress: [progressRow({ id: "p1" })],
  });
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.equal(event.subjectId, 493016, "条目 id 取错了");
    assert.equal(event.subjectTitle, "异国日记", "条目标题取错了");
    assert.equal(event.coverUrl, "https://x/c.jpg");
  }
});

test("收藏时间优先用 collectedAt，而不是被 updatedAt 盖掉", () => {
  // collectedAt 是「加入收藏的时间」（来自上游），updatedAt 是本地修改时间。
  // 用错会让时光机按「最近动过」而不是「最近收藏」排。
  const events = buildTimeline({
    ...empty,
    collections: [
      collectionRow({ collectedAt: at("2026-03-01T00:00:00Z"), updatedAt: at("2026-01-01T00:00:00Z") }),
    ],
  });
  assert.equal(events[0].at.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("没有 collectedAt 时退回 updatedAt（站内手动收藏就是这种情况）", () => {
  const events = buildTimeline({
    ...empty,
    collections: [collectionRow({ collectedAt: null, updatedAt: at("2026-02-01T00:00:00Z") })],
  });
  assert.equal(events.length, 1, "没有 collectedAt 的收藏被整条丢掉了");
  assert.equal(events[0].at.toISOString(), "2026-02-01T00:00:00.000Z");
  assert.ok(Number.isFinite(events[0].at.getTime()), "产生了 Invalid Date");
});

test("收藏状态标签与追番页同源（同一份权威映射）", () => {
  const events = buildTimeline({
    ...empty,
    collections: [collectionRow({ type: 3, collectedAt: at("2026-01-01T00:00:00Z") })],
  });
  // 3 = 在看（映射反直觉，曾写错过）
  assert.equal(events[0].kind === "collection" && events[0].statusLabel, "在看");
});

test("进度类型有中文标签，未知类型有兜底而不是 undefined", () => {
  assert.equal(PROGRESS_LABELS[2], "看过");
  const events = buildTimeline({
    ...empty,
    progress: [progressRow({ id: "p1", type: 2 }), progressRow({ id: "p2", type: 99 })],
  });
  for (const event of events) {
    assert.equal(event.kind, "progress");
    assert.ok(
      event.kind === "progress" && event.progressLabel.length > 0,
      "出现了空标签",
    );
  }
});

test("长评与短评被区分", () => {
  const events = buildTimeline({
    ...empty,
    reviews: [
      reviewRow({ id: "long", kind: 1, content: "长", createdAt: at("2026-01-02T00:00:00Z") }),
      reviewRow({ id: "short", kind: 0, content: "短", createdAt: at("2026-01-01T00:00:00Z") }),
    ],
  });
  assert.equal(events[0].kind === "review" && events[0].isLong, true);
  assert.equal(events[1].kind === "review" && events[1].isLong, false);
});

test("excerpt 压平换行并截断 —— 多行文本会撑高整行", () => {
  assert.equal(excerpt("第一行\n第二行\t第三行"), "第一行 第二行 第三行");
  assert.equal(excerpt("  前后有空白  "), "前后有空白");
  const long = excerpt("x".repeat(200));
  assert.ok(long.length <= 121, `未截断：${long.length}`);
  assert.ok(long.endsWith("…"));
  assert.equal(excerpt("短"), "短", "短文本不该被加省略号");
});

test("空输入返回空数组，不抛错", () => {
  assert.deepEqual(buildTimeline(empty), []);
});

test("条目缺中文名时退回原名，而不是空标题", () => {
  const events = buildTimeline({
    ...empty,
    collections: [
      collectionRow({
        collectedAt: at("2026-01-01T00:00:00Z"),
        subject: { ...subject, nameCn: null },
      }),
    ],
  });
  assert.equal(events[0].subjectTitle, "異国日記");
});

/* ---------------------------------------------------------------- *
 * 进度折叠
 * ---------------------------------------------------------------- */

test("同一人对同一条目的连续进度被折叠成一条", () => {
  // 补看一部番会产生几十条进度，彼此只差几毫秒。不折叠的话时光机默认的
  // 60 条会被同一个人的同一部番占满，其余活动全被挤出行外 —— 等于失效。
  const events = buildTimeline({
    ...empty,
    progress: [
      progressRow({ id: "p1", type: 2, updatedAt: at("2026-01-01T00:00:05Z") }),
      progressRow({ id: "p2", type: 2, updatedAt: at("2026-01-01T00:00:04Z") }),
      progressRow({ id: "p3", type: 2, updatedAt: at("2026-01-01T00:00:03Z") }),
      progressRow({ id: "p4", type: 2, updatedAt: at("2026-01-01T00:00:02Z") }),
    ],
  });

  assert.equal(events.length, 1, "连续进度没有被折叠");
  const event = events[0];
  assert.equal(event.kind, "progress");
  assert.equal(event.kind === "progress" && event.episodeCount, 4);
  assert.match(event.kind === "progress" ? event.episodeLabel : "", /共 4 集/);
  // 时间取最新的那条
  assert.equal(event.at.toISOString(), "2026-01-01T00:00:05.000Z");
});

test("被其他活动隔开的进度不折叠 —— 否则跨度很怪", () => {
  const events = buildTimeline({
    ...empty,
    progress: [
      progressRow({ id: "p1", updatedAt: at("2026-01-03T00:00:00Z") }),
      progressRow({ id: "p3", updatedAt: at("2026-01-01T00:00:00Z") }),
    ],
    collections: [collectionRow({ id: "c1", collectedAt: at("2026-01-02T00:00:00Z") })],
  });

  assert.deepEqual(events.map((e) => e.kind), ["progress", "collection", "progress"]);
  assert.equal(events[0].kind === "progress" && events[0].episodeCount, 1);
});

test("不同条目的进度不折叠（即使同一人、时间相邻）", () => {
  const other = { ...subject, id: 999 };
  const events = buildTimeline({
    ...empty,
    progress: [
      progressRow({ id: "p1", updatedAt: at("2026-01-01T00:00:02Z") }),
      progressRow({ id: "p2", updatedAt: at("2026-01-01T00:00:01Z"), episode: { ep: 1, sort: 1, subject: other } }),
    ],
  });
  assert.equal(events.length, 2, "不同条目被错误地折叠到一起");
});

test("不同人的进度不折叠", () => {
  const otherUser = { id: "u2", nickname: "别人", avatarUrl: null, schoolId: "hit" };
  const events = buildTimeline({
    ...empty,
    progress: [
      progressRow({ id: "p1", updatedAt: at("2026-01-01T00:00:02Z") }),
      progressRow({ id: "p2", updatedAt: at("2026-01-01T00:00:01Z"), user: otherUser }),
    ],
  });
  assert.equal(events.length, 2, "不同用户被错误地折叠到一起");
});

test("折叠不会丢掉非进度事件", () => {
  const events = buildTimeline({
    ...empty,
    progress: [progressRow({ id: "p1" }), progressRow({ id: "p2" })],
    reviews: [reviewRow({ id: "r1", createdAt: at("2025-12-31T00:00:00Z") })],
    collections: [collectionRow({ id: "c1", collectedAt: at("2025-12-30T00:00:00Z") })],
  });
  assert.deepEqual(
    [...new Set(events.map((e) => e.kind))].sort(),
    ["collection", "progress", "review"],
  );
});

test("foldProgress 对空数组与单个事件是恒等的", () => {
  assert.deepEqual(foldProgress([]), []);
  const single = buildTimeline({ ...empty, collections: [collectionRow({ collectedAt: at("2026-01-01T00:00:00Z") })] });
  assert.deepEqual(foldProgress(single).map((e) => e.id), single.map((e) => e.id));
});
