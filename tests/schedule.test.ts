/**
 * 新番时间表的日期计算单测。
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isoDate, parseIsoDate, weekRange, weekdayLabel } from "@/lib/schedule";

test("weekRange 以周一为起点（周三）", () => {
  // 2026-09-23 是周三
  const { start, end } = weekRange(new Date(Date.UTC(2026, 8, 23)));
  assert.equal(isoDate(start), "2026-09-21");
  assert.equal(isoDate(end), "2026-09-27");
});

test("weekRange 以周一为起点（周日归入上一周）", () => {
  // 2026-09-27 是周日
  const { start, end } = weekRange(new Date(Date.UTC(2026, 8, 27)));
  assert.equal(isoDate(start), "2026-09-21");
  assert.equal(isoDate(end), "2026-09-27");
});

test("weekRange 以周一为起点（周一当天即本周起点）", () => {
  const { start, end } = weekRange(new Date(Date.UTC(2026, 8, 21)));
  assert.equal(isoDate(start), "2026-09-21");
  assert.equal(isoDate(end), "2026-09-27");
});

test("weekRange 支持正负周偏移，且跨月正确", () => {
  const now = new Date(Date.UTC(2026, 8, 23));
  assert.equal(isoDate(weekRange(now, 1).start), "2026-09-28");
  assert.equal(isoDate(weekRange(now, 2).end), "2026-10-11");
  assert.equal(isoDate(weekRange(now, -1).start), "2026-09-14");
  assert.equal(isoDate(weekRange(now, -2).end), "2026-09-13");
});

test("weekRange 跨度恒为 7 天", () => {
  const now = new Date(Date.UTC(2026, 11, 31));
  const { start, end } = weekRange(now, 0);
  assert.equal(end.getTime() - start.getTime(), 6 * 24 * 60 * 60 * 1000);
});

test("parseIsoDate 接受合法日期并拒绝非法输入", () => {
  assert.equal(isoDate(parseIsoDate("2026-09-23")!), "2026-09-23");
  assert.equal(parseIsoDate("2026-9-23"), null);
  assert.equal(parseIsoDate(""), null);
  assert.equal(parseIsoDate("not-a-date"), null);
});

test("weekdayLabel 映射到中文星期", () => {
  const { start } = weekRange(new Date(Date.UTC(2026, 8, 23)));
  const labels = Array.from({ length: 7 }, (_, index) =>
    weekdayLabel(new Date(start.getTime() + index * 24 * 60 * 60 * 1000), start),
  );
  assert.deepEqual(labels, ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]);
});
