/**
 * BGM 分页算术测试。
 *
 * ## 这些断言防的是什么
 *
 * 首页「下一页」曾经**完全无效**：第 2 页与第 1 页逐字相同。根因是偏移
 * 硬编码成了常量，完全没读 `page`。修的过程中又发现第二个问题：请求 24 条
 * 而上游每页只给 20 条，偏移却按 24 递增 —— 每页跳过 4 条。
 *
 * 两种错误都**不会抛异常**，页面照常 200，只是内容不对。所以只能靠测试钉住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BGM_MAX_PAGE_SIZE, pageCount, pageOffset } from "@/lib/bgm/paging";

const HERO = 8;

test("每页偏移按固定步长递增，且步长等于上游每页条数", () => {
  // 若步长小于上游实际返回条数，页与页之间会**重叠**；
  // 若大于，会**跳过**条目。两者都静默。
  assert.equal(BGM_MAX_PAGE_SIZE, 20, "上游实测每页 20 条，改动需先核实");
  assert.equal(pageOffset(1), 0);
  assert.equal(pageOffset(2), 20);
  assert.equal(pageOffset(3), 40);
  assert.equal(pageOffset(10), 180);
});

test("相邻两页既不重叠也不留空隙", () => {
  for (let page = 1; page < 12; page += 1) {
    const current = pageOffset(page);
    const next = pageOffset(page + 1);
    assert.equal(
      next - current,
      BGM_MAX_PAGE_SIZE,
      `第 ${page}→${page + 1} 页的间隔必须正好是一页，否则内容会重叠或跳过`,
    );
  }
});

test("分页必须真的随页码变化（曾经这里返回常量）", () => {
  // 这条直接对着那个 bug：偏移曾与 page 无关，于是翻页毫无效果。
  assert.notEqual(pageOffset(1), pageOffset(2));
  assert.notEqual(pageOffset(1, HERO), pageOffset(2, HERO));
});

test("Hero 占位把第一页网格整体后移，且不带进 Hero 的条目", () => {
  // 首页 Hero 展示前 8 条，推荐网格必须从第 9 条开始，否则一屏里同一部番
  // 会出现在两处。
  assert.equal(pageOffset(1, HERO), HERO);
  assert.equal(pageOffset(1, 0), 0, "搜索模式没有 Hero，应从第 0 条开始");
  assert.equal(pageOffset(2, HERO), HERO + BGM_MAX_PAGE_SIZE);
});

test("非法页码退回第 1 页，不产生负偏移或 NaN", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.7]) {
    const offset = pageOffset(bad, HERO);
    assert.ok(Number.isInteger(offset), `page=${bad} 得到非整数偏移 ${offset}`);
    assert.ok(offset >= 0, `page=${bad} 得到负偏移 ${offset}`);
  }
  assert.equal(pageOffset(1.7, HERO), HERO, "小数页向下取整");
});

test("总页数从总数里减掉 Hero 占用的条目", () => {
  // 不减的话最后一页会指向一个已被 Hero 拿走的偏移，翻到那里会看到重复内容。
  assert.equal(pageCount(1000, 0), 50);
  assert.equal(pageCount(1000, HERO), 50, "(1000-8)/20 = 49.6 → 50");
  assert.equal(pageCount(28, HERO), 1, "(28-8)/20 = 1 → 1");
  assert.equal(pageCount(29, HERO), 2, "(29-8)/20 = 1.05 → 2");
});

test("总页数至少为 1，不会出现「第 1 / 0 页」", () => {
  for (const total of [0, 1, HERO, HERO + 1]) {
    assert.ok(pageCount(total, HERO) >= 1, `total=${total} 得出页数 ${pageCount(total, HERO)}`);
  }
});

test("最后一页的偏移仍在总数之内", () => {
  for (const total of [0, 1, 20, 21, 100, 1000, HERO]) {
    const pages = pageCount(total, HERO);
    const lastOffset = pageOffset(pages, HERO);
    assert.ok(
      lastOffset <= Math.max(HERO, total),
      `total=${total} 有 ${pages} 页，但最后一页偏移 ${lastOffset} 已越界`,
    );
  }
});
