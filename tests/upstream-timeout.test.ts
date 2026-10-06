/**
 * 「上游请求必须有超时」的源码检查。
 *
 * ## 防的是什么
 *
 * 项目明确规定「所有上游请求必须有内置超时」。这条规则此前由 `request()`
 * 这一个包装函数承担 —— 于是**绕过它的裸 `fetch` 就自动不受约束**。
 *
 * 实测找到 **3 处**这样的裸 fetch，全在 OAuth 关键路径上：
 *
 * | 位置 | 用途 |
 * |---|---|
 * | `client.ts` `postToken` | 授权码换 token、刷新 token |
 * | `bgm-oauth.ts` `fetchBgmIdentity` | `GET /v0/me` |
 * | `bgm-oauth.ts` `fetchTokenExpiry` | `POST /token_status` |
 *
 * 后果不是「慢」而是**无限挂起**：bgm.tv 那边不响应时，回调请求会一直悬着 ——
 * 用户看着浏览器转圈，服务端也一直占着一个连接。
 *
 * ## 为什么用源码检查
 *
 * 行为测试很难覆盖这一点：要断言「没有超时」得让 fetch 永不 resolve，
 * 而那会让测试本身也挂住（除非用假定时器，成本更高且只覆盖被写到的那个函数）。
 * 源码检查能一次性覆盖**所有** fetch 调用点，包括将来新增的。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** 所有会发起上游请求的模块。新增时加进来。 */
const NETWORK_MODULES = [
  "src/lib/bgm/client.ts",
  "src/lib/auth/bgm-oauth.ts",
];

/**
 * 去掉注释，避免注释里的 `fetch(` / `NextResponse.json` 被误判。
 *
 * **必须保留换行** —— 行号是按这个结果算的。第一版把块注释整段压成一个
 * 空格，换行随之消失，于是报出的行号整体偏小（实测：实际第 78 行报了第 58 行）。
 * 一个指向错误位置的报错比不报还费时间。
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * 切出每个 `fetch(` 到其闭合 `});` 之间的代码块，附带起始行号。
 *
 * 必须锚定 `fetch(` 这个字面量 —— 第一版写成 `await fetch\(` 时把
 * `withRetry` 里的 `await fn()` 也匹配进来了（它后面同样跟着跨行的 `});`），
 * 于是报出一个假的「没有超时」。检测器误报比漏报更糟：它会让人不再信任工具。
 */
function fetchBlocks(source: string): { line: number; block: string }[] {
  const blocks: { line: number; block: string }[] = [];
  const re = /fetch\(([\s\S]*?)\n\s*\}\);/g;
  for (const match of source.matchAll(re)) {
    blocks.push({
      line: source.slice(0, match.index).split("\n").length,
      block: match[0],
    });
  }
  return blocks;
}

test("每一处上游 fetch 都带超时（signal）", () => {
  const offenders: string[] = [];

  for (const file of NETWORK_MODULES) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const { line, block } of fetchBlocks(source)) {
      // `signal,` 是简写属性，同样有效 —— 只认 `signal:` 会误报（实测踩到）
      if (!/\bsignal\b|AbortSignal\.timeout/.test(block)) {
        offenders.push(`${file}:${line}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `这些 fetch 没有超时 —— bgm.tv 挂住时会让请求无限悬着：\n  ${offenders.join("\n  ")}`,
  );
});

test("扫描确实找到了 fetch 调用点（不是扫了空集）", () => {
  // 空集上的检查永远通过。这里确认解析器真的抓到了已知的调用点。
  const total = NETWORK_MODULES.reduce(
    (sum, file) => sum + fetchBlocks(withoutComments(readFileSync(file, "utf8"))).length,
    0,
  );
  assert.ok(total >= 4, `只解析到 ${total} 个 fetch 块 —— 解析器可能失效了`);
});

test("检查器自身有效 —— 无 signal 的块会被抓到", () => {
  const sample = `
    const a = await fetch("https://x.test", {
      method: "POST",
      cache: "no-store",
    });
    const b = await fetch("https://y.test", {
      signal: AbortSignal.timeout(1000),
    });
    // 非 fetch 的调用不该被算进来（withRetry 里的 fn() 就长这样）
    const c = await withRetry(fn, "label");`;
  const blocks = fetchBlocks(sample);
  assert.equal(blocks.length, 2, `应只解析出 2 个 fetch 块，实际 ${blocks.length}`);
  assert.equal(/\bsignal\b|AbortSignal\.timeout/.test(blocks[0]!.block), false, "无 signal 的块应被识别");
  assert.equal(/\bsignal\b|AbortSignal\.timeout/.test(blocks[1]!.block), true);

  // 简写属性也必须被认作「有超时」—— 这是第一版的误报点
  const shorthand = `fetch("https://z.test", {\n      signal,\n    });`;
  assert.equal(
    /\bsignal\b|AbortSignal\.timeout/.test(fetchBlocks(shorthand)[0]!.block),
    true,
    "简写属性 signal, 应被认作有超时",
  );
});
