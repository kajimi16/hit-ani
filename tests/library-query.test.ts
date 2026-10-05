/**
 * 追番页的查询参数与排序映射测试。
 *
 * ## 防的是什么
 *
 * 两者写错都**不会抛异常**，只让列表「看起来没生效」：
 * - 参数解析认不出 `sort=score` → 静默退回默认排序，用户以为排序功能坏了；
 * - `orderBy` 缺少并列次序 → 同分条目每次查询顺序不同，翻页还会重复或漏条；
 * - 可空列用 `DESC` 而未指定 `nulls` → Postgres 把 NULL 排在最前，
 *   「按我的评分排序」结果一屏全是「未评分」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LIBRARY_SORT,
  DEFAULT_LIBRARY_VIEW,
  LIBRARY_PAGE_SIZE,
  LIBRARY_SORTS,
  libraryHref,
  parseLibraryQuery,
} from "@/lib/library-query";
import { collectionOrderBy } from "@/lib/library-sort";

/* ---------------------------------------------------------------- *
 * 参数解析
 * ---------------------------------------------------------------- */

test("合法排序被接受，非法值退回默认而不是报错", () => {
  // 用户手改 URL 或点旧书签不该看到 500
  for (const option of LIBRARY_SORTS) {
    assert.equal(parseLibraryQuery({ sort: option.value }).sort, option.value);
  }
  for (const bad of ["", "SCORE", "newest", "1", "recent;drop", undefined]) {
    assert.equal(parseLibraryQuery({ sort: bad as string }).sort, DEFAULT_LIBRARY_SORT);
  }
});

test("视图默认是网格，非法值退回网格", () => {
  assert.equal(parseLibraryQuery({}).view, DEFAULT_LIBRARY_VIEW);
  assert.equal(parseLibraryQuery({ view: "list" }).view, "list");
  for (const bad of ["LIST", "table", "", undefined]) {
    assert.equal(parseLibraryQuery({ view: bad as string }).view, DEFAULT_LIBRARY_VIEW);
  }
});

test("页码：非法输入一律退回第 1 页，不产生越界 skip", () => {
  assert.equal(parseLibraryQuery({ page: "3" }).page, 3);
  assert.equal(parseLibraryQuery({}).page, 1);
  // 负数 / 0 / 小数 / NaN / Infinity 都要安全
  for (const bad of ["0", "-5", "1.7", "abc", "Infinity", "NaN", ""]) {
    const page = parseLibraryQuery({ page: bad }).page;
    assert.ok(Number.isInteger(page) && page >= 1, `page=${JSON.stringify(bad)} 得到 ${page}`);
  }
  assert.equal(parseLibraryQuery({ page: "1.7" }).page, 1, "小数向下取整到 1");
});

/* ---------------------------------------------------------------- *
 * 排序映射
 * ---------------------------------------------------------------- */

test("每种排序都以主键收尾 —— 保证全序，翻页不会重复或漏条", () => {
  // 只按 score 排时，同分的几十条每次查询顺序可能不同；翻页会重复/漏条。
  for (const option of LIBRARY_SORTS) {
    const order = collectionOrderBy(option.value);
    assert.ok(order.length >= 2, `${option.value} 只给了单个排序键，顺序不稳定`);
    assert.deepEqual(
      order[order.length - 1],
      { id: "asc" },
      `${option.value} 的最后一级应当是稳定的主键`,
    );
  }
});

test("可空列的排序必须显式 nulls: last —— 否则 NULL 会顶到最前", () => {
  // Postgres 的 DESC 默认把 NULL 排在最前，于是「按我的评分」一屏全是未评分。
  const collected = collectionOrderBy("collected");
  assert.deepEqual(collected[0], { collectedAt: { sort: "desc", nulls: "last" } });

  const mine = collectionOrderBy("myrating");
  assert.deepEqual(mine[0], { rating: { sort: "desc", nulls: "last" } });

  const bgm = collectionOrderBy("score");
  assert.deepEqual(bgm[0], { subject: { score: { sort: "desc", nulls: "last" } } });
});

test("「加入时间」用 collectedAt，不是 updatedAt", () => {
  // updatedAt 是 Prisma 自动维护的本地修改时间 —— 改一次评分就刷新，
  // 用它会变成「按最近动过排序」，等于没实现用户要的功能。
  const order = collectionOrderBy("collected");
  const keys = order.flatMap((entry) => Object.keys(entry));
  assert.ok(keys.includes("collectedAt"), "应当按 collectedAt 排序");
  assert.equal(keys[0], "collectedAt", "主排序键必须是 collectedAt");
});

test("四种排序产出互不相同的首位键 —— 不存在「两个选项效果一样」", () => {
  const firstKeys = LIBRARY_SORTS.map((option) => {
    const order = collectionOrderBy(option.value);
    const [first] = order;
    return JSON.stringify(first);
  });
  assert.equal(new Set(firstKeys).size, firstKeys.length, "有两个排序选项实际是同一个顺序");
});

test("未知排序退回「最近更新」，不抛错", () => {
  assert.deepEqual(
    collectionOrderBy("nonsense" as never),
    collectionOrderBy("recent"),
  );
});

/* ---------------------------------------------------------------- *
 * 链接构造
 * ---------------------------------------------------------------- */

test("切排序不清空状态筛选与视图", () => {
  // 这是最容易漏的一处：分页、排序、视图三种链接都要保留另外两类参数。
  const href = libraryHref({ status: "doing", sort: "score", view: "list", page: 3 });
  const url = new URL(href, "http://x");
  assert.equal(url.searchParams.get("status"), "doing");
  assert.equal(url.searchParams.get("sort"), "score");
  assert.equal(url.searchParams.get("view"), "list");
  assert.equal(url.searchParams.get("page"), "3");
});

test("默认值不写进 URL —— 链接保持干净", () => {
  assert.equal(libraryHref({ sort: DEFAULT_LIBRARY_SORT, view: DEFAULT_LIBRARY_VIEW }), "/library");
  assert.equal(libraryHref({ sort: DEFAULT_LIBRARY_SORT, view: DEFAULT_LIBRARY_VIEW, page: 1 }), "/library");
});

test("链接可被自己解析回来（往返一致）", () => {
  for (const sort of LIBRARY_SORTS.map((o) => o.value)) {
    const href = libraryHref({ status: "wish", sort, view: "list", page: 2 });
    const url = new URL(href, "http://x");
    const parsed = parseLibraryQuery(Object.fromEntries(url.searchParams) as never);
    assert.equal(parsed.sort, sort);
    assert.equal(parsed.view, "list");
    assert.equal(parsed.page, 2);
  }
});

test("每页条数是个合理值（分页修复卡顿的前提）", () => {
  // 太大就回到「一次渲染几百条」的老问题
  assert.ok(LIBRARY_PAGE_SIZE > 0 && LIBRARY_PAGE_SIZE <= 100, `每页 ${LIBRARY_PAGE_SIZE} 条不合理`);
});
