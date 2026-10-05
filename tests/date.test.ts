/**
 * 日期解析测试。
 *
 * ## 防的是什么
 *
 * 这个函数在仓里曾有**四份**复制品，其中三份带着同一个 bug：
 *
 *     new Date(Date.UTC(2026, 12, 45))  // 不报错 → 2027-02-14
 *
 * `Date.UTC` 对越界的月/日**静默进位**，而 `^\d{4}-\d{2}-\d{2}$` 只保证位数。
 * 后果是上游一个坏日期被悄悄存成另一个日期 —— 用户看到凭空捏造的首播时间，
 * 且全链路无任何报错。收敛到一处之后，这组断言守着所有调用方。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isoDate, parseIsoDate } from "@/lib/date";

test("解析合法日期为 UTC 零点", () => {
  const date = parseIsoDate("2026-01-04")!;
  assert.equal(date.getUTCFullYear(), 2026);
  assert.equal(date.getUTCMonth(), 0);
  assert.equal(date.getUTCDate(), 4);
  assert.equal(date.getUTCHours(), 0);
  assert.equal(date.getUTCMinutes(), 0);
});

test("用 UTC 而非本地时间 —— 否则 UTC+8 会把日期算少一天", () => {
  // 用本地时间构造时，2026-01-04 在 UTC+8 上会变成 2026-01-03T16:00Z。
  assert.equal(isoDate(parseIsoDate("2026-01-04")!), "2026-01-04");
  for (const day of ["2026-01-01", "2026-06-15", "2026-12-31"]) {
    assert.equal(isoDate(parseIsoDate(day)!), day, `${day} 往返不一致`);
  }
});

test("越界的月 / 日必须被拒绝，而不是被 Date.UTC 静默进位", () => {
  // 这是那个 bug 的直接回归防线。
  // `Date.UTC(2026, 12, 45)` 会得到 2027-02-14 —— 若没有回读校验就会存进去。
  for (const bad of ["2026-13-01", "2026-00-10", "2026-01-45", "2026-02-30", "2026-04-31"]) {
    assert.equal(parseIsoDate(bad), null, `${bad} 被进位了，没被拒绝`);
  }
});

test("闰年的 2 月 29 日合法，平年不合法", () => {
  assert.equal(isoDate(parseIsoDate("2024-02-29")!), "2024-02-29", "2024 是闰年");
  assert.equal(parseIsoDate("2026-02-29"), null, "2026 不是闰年");
  // 世纪闰年规则：2000 是闰年，1900 不是
  assert.equal(isoDate(parseIsoDate("2000-02-29")!), "2000-02-29");
  assert.equal(parseIsoDate("1900-02-29"), null);
});

test("位数不足或格式不符一律拒绝", () => {
  for (const bad of ["2026-1-4", "2026/01/04", "26-01-04", "2026-01-04T00:00:00Z", " 2026-01-04 ".trim() + "x", "not-a-date", "20260104"]) {
    assert.equal(parseIsoDate(bad), null, `${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("空输入返回 null（BGM 对未定档条目会返回空串）", () => {
  for (const empty of ["", "   ", null, undefined]) {
    assert.equal(parseIsoDate(empty), null);
  }
});

test("首尾空白被容忍", () => {
  assert.equal(isoDate(parseIsoDate("  2026-01-04  ")!), "2026-01-04");
});

test("年份边界不产生 0 或负数", () => {
  // `Date.UTC(0, ...)` 会被解释成 1900 年；`0000` 也非法。
  assert.equal(parseIsoDate("0000-01-01"), null);
  const y1 = parseIsoDate("0001-01-01");
  if (y1) assert.equal(y1.getUTCFullYear(), 1, "0001 若被接受，年份应为 1 而非 1901");
});
