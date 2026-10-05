/**
 * 推荐查询的「按请求求值」语义测试。
 *
 * ## 为什么值得单独一个文件
 *
 * 这个查询里嵌了一个**相对当前时间**的日期下界（「近一年」）。它曾经被写成
 * 模块级常量，于是在**模块加载时**（即进程启动那一刻）求值一次，之后再也不变 ——
 * 容器跑得越久，下界越旧，窗口悄悄从「近一年」滑向「近两年」。
 *
 * 这种错误不抛异常、不打日志，只是首页慢慢混入越来越旧的作品。唯一能防住
 * 它的手段就是让「按调用时刻求值」这句语义被测试直接钉住。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { recentCutoff, recommendQuery } from "@/lib/bgm/recommend";

const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const lowerBound = (now: Date): string =>
  String(recommendQuery(now).filter.air_date[0]).replace(/^>=/, "");

test("下界随调用时刻推进，而不是冻在第一次调用", () => {
  // 这条直接对着那个 bug：常量版本在两次调用间会给出同一个日期。
  assert.equal(lowerBound(at("2026-10-05")), "2025-10-05");
  assert.equal(lowerBound(at("2027-10-05")), "2026-10-05");
  assert.notEqual(
    lowerBound(at("2026-10-05")),
    lowerBound(at("2027-10-05")),
    "相隔一年必须给出不同的下界，否则窗口在悄悄变宽",
  );
});

test("跨度正好是一年，且用 UTC 计算（不受时区影响）", () => {
  assert.equal(recentCutoff(at("2026-10-05")), "2025-10-05");
  assert.equal(recentCutoff(at("2026-01-01")), "2025-01-01");
  // 闰年：2 月 29 日往前一年落到 3 月 1 日（UTC 归一化行为），
  // 关键是**不抛异常**且结果可解析
  const leap = recentCutoff(at("2024-02-29"));
  assert.match(leap, /^\d{4}-\d{2}-\d{2}$/, `闰日得到的下界不可解析：${leap}`);
});

test("输出是 BGM 接受的 `YYYY-MM-DD`，且带 `>=` 前缀", () => {
  const filter = recommendQuery(at("2026-10-05")).filter;
  assert.equal(filter.air_date.length, 1);
  assert.match(filter.air_date[0], /^>=\d{4}-\d{2}-\d{2}$/);
});

test("查询限定动画且排除 NSFW", () => {
  const q = recommendQuery(at("2026-10-05"));
  assert.equal(q.keyword, "", "推荐不要关键词，否则会走成搜索");
  assert.equal(q.sort, "heat", "按收藏人数排序 —— 我们没有推荐系统");
  assert.deepEqual(q.filter.type, [2], "type 2 = 动画");
  assert.equal(q.filter.nsfw, false);
});

test("每次调用返回全新对象（调用方不会互相污染）", () => {
  const a = recommendQuery(at("2026-10-05"));
  const b = recommendQuery(at("2026-10-05"));
  assert.notEqual(a, b);
  assert.notEqual(a.filter, b.filter);
  assert.notEqual(a.filter.air_date, b.filter.air_date);
});

test("不得在模块作用域求值 —— 源码层面锁死这个反模式", () => {
  // 上一条测的是行为，这条测的是**写法**。两者都要：
  // 只要有人把 `recommendQuery()` 改成模块级 `const`，行为测试在同一个
  // 进程内仍然可能通过（导入那一刻算出来的值恰好是对的），
  // 而源码检查会立刻失败。
  const source = readFileSync(new URL("../src/lib/bgm/recommend.ts", import.meta.url), "utf8");

  // 只看顶格的**赋值语句** —— 模块级求值必然长这样。
  // 不去禁止函数签名里的 `new Date()`：那是默认参数，在**调用时**求值，
  // 正是本模块要的语义（早先的检查一视同仁，把默认参数也判为违规，是假阳性）。
  const moduleScopeInitializers = source
    .split("\n")
    .filter((line) => /^(const|let|var)\b/.test(line))
    .join("\n");

  assert.equal(
    /(new Date\(\)|recentCutoff\(|recommendQuery\()/.test(moduleScopeInitializers),
    false,
    "模块级初始化不得求值时间 —— 那会把「近一年」冻在进程启动那一刻",
  );

  // 反过来确认默认参数确实存在（本模块依赖它做测试注入）
  assert.match(source, /now: Date = new Date\(\)/, "默认参数应保留，它按调用求值");
});

