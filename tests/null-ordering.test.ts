/**
 * 「可空列排序必须显式指定 nulls」的源码检查。
 *
 * ## 为什么用源码检查而不是行为测试
 *
 * 这是 Postgres 的**查询语义**，不是我们能单测的纯逻辑：`ORDER BY x DESC`
 * 默认把 NULL 排在最前，而正确行为要求 `nulls: "last"`。要测出差异得跑一个
 * 真实 Postgres 并造 null 数据 —— 而 `ORDER BY` 又散落在各处的 Prisma 调用里。
 *
 * 这个坑在本项目**已经踩过两次**：
 *   1. 追番页「按我的评分排序」—— 未评分的条目（rating = null）会顶到最前；
 *   2. 时光机按收藏时间排序 —— `collectedAt` 为 null 的条目占满首页。
 *
 * 两次都是「顺序看起来有点怪」，没有任何报错。因此这里扫源码：凡是按可空
 * 时间/数值列排序的地方，都必须写成 `{ sort, nulls }` 的形式。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 可空且会被排序的列。
 *
 * 加列时要一并加进来 —— 但只有「确实会为 null」的列才算：
 * `id` / `createdAt` / `updatedAt` 这些必填列不需要 `nulls`。
 */
const NULLABLE_SORT_COLUMNS = [
  "collectedAt", // Collection.collectedAt —— 上游没给时间时为 null
  "rating", // Collection.rating —— 用户没评分时为 null（myrating 排序）
  "score", // Subject.score —— 冷门条目没有评分
  "rank", // Subject.rank —— 同上
  "airDate", // Subject.airDate —— 未定档
];

/**
 * 项目里所有会写 `orderBy` 的源码。
 *
 * 用**文件系统遍历**而不是 `git ls-files`：后者只列已跟踪文件，于是
 * **新写的文件在 `git add` 之前完全不被检查** —— 而「刚写完还没提交」
 * 恰恰是最需要被检查的时刻。这个盲区是实测发现的（把检查规则注入到一个
 * 未跟踪的新文件里，检查照样通过）。
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
    }
  };
  walk("src");
  return out;
}

test("按可空列排序时必须显式 nulls —— 否则 NULL 会顶到最前", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("orderBy")) continue;

    for (const column of NULLABLE_SORT_COLUMNS) {
      // 匹配 `column: "desc"` / `column: "asc"` 这种简写形式 ——
      // 带 `{ sort, nulls }` 的写法不会命中（值不是字符串）。
      const shorthand = new RegExp(`${column}\\s*:\\s*"(asc|desc)"`, "g");
      for (const match of source.matchAll(shorthand)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file}:${line} 的 ${column} 用了 ${match[0]}，缺 nulls`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下排序会把 NULL 排到最前：\n  ${offenders.join("\n  ")}`,
  );
});

test("扫描确实覆盖了源码目录（不是扫了个空集）", () => {
  // 空集上的检查永远通过。这里确认遍历真的找到了文件，且包含我们关心的那些。
  const files = sourceFiles();
  assert.ok(files.length > 20, `只扫到 ${files.length} 个文件，遍历有问题`);
  assert.ok(
    files.some((f) => f.includes("library-sort")),
    "没扫到已知带 orderBy 的文件",
  );
});

test("检查本身有效 —— 简写形式确实会被匹配到", () => {
  // 防止正则写错导致上面那条永远通过（空断言没有价值）。
  const sample = 'orderBy: { collectedAt: "desc" }';
  const shorthand = new RegExp(`${"collectedAt"}\\s*:\\s*"(asc|desc)"`, "g");
  assert.ok(shorthand.test(sample), "正则没匹配到简写形式，检查形同虚设");

  // 正确写法不该被误报
  const correct = 'orderBy: { collectedAt: { sort: "desc", nulls: "last" } }';
  assert.equal(
    new RegExp(`${"collectedAt"}\\s*:\\s*"(asc|desc)"`, "g").test(correct),
    false,
    "带 nulls 的正确写法被误报了",
  );
});
