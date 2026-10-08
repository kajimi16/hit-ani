/**
 * 上游响应缓存测试。
 *
 * ## 防的是什么
 *
 * 这个模块存在的唯一理由是**少打上游**（配额 + 限流）。因此最重要的断言不是
 * 「存进去能读出来」，而是「**新鲜命中时根本不调 loader**」——
 * 后者才是省配额的那一步，而它坏掉时页面**看起来完全正常**，
 * 只是配额悄悄被烧掉。
 *
 * 第二条重要的是「上游失败时吃陈旧数据」。这个部署的上游经常不可用
 * （校园网 + 代理链路），时间表原先 `.catch(() => null)` → 整页空档期表。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  STALE_MAX_MS,
  compressJson,
  decompressJson,
  pruneUpstreamCache,
  readUpstreamCache,
  upstreamCacheStats,
  withUpstreamCache,
  writeUpstreamCache,
} from "@/lib/cache/upstream-cache";

/** 测试用的命名空间前缀 —— 只清理自己的行，不动生产数据。 */
const NS = "test-upstream-cache";

async function cleanup(): Promise<void> {
  await prisma.upstreamCache.deleteMany({ where: { namespace: { startsWith: NS } } });
}

after(cleanup);

test("★ 新鲜命中时**根本不调 loader** —— 省配额就靠这一步", async () => {
  await cleanup();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { n: calls };
  };
  const opts = { namespace: NS, key: "fresh", ttlMs: 60_000 };

  const first = await withUpstreamCache(opts, loader);
  const second = await withUpstreamCache(opts, loader);
  const third = await withUpstreamCache(opts, loader);

  assert.equal(calls, 1, `loader 应只被调用 1 次，实际 ${calls} 次`);
  assert.deepEqual(first, { n: 1 });
  assert.deepEqual(second, { n: 1 }, "第二次必须来自缓存");
  assert.deepEqual(third, { n: 1 });
});

test("★ 上游失败时返回**陈旧**数据，而不是让页面空着", async () => {
  await cleanup();
  const ttlMs = 1000;
  let now = 1_000_000;
  await withUpstreamCache(
    { namespace: NS, key: "stale", ttlMs, now: () => now },
    async () => ({ day: "周一", items: 3 }),
  );

  // 时间前进到过期之后（但仍在陈旧上界内）
  now += ttlMs + 1;

  const logs: string[] = [];
  const value = await withUpstreamCache(
    { namespace: NS, key: "stale", ttlMs, now: () => now, log: (m) => logs.push(m) },
    async () => {
      throw new Error("上游 502");
    },
  );

  assert.deepEqual(value, { day: "周一", items: 3 }, "应回退到陈旧数据");
  assert.ok(
    logs.some((l) => l.includes("陈旧")),
    `应记录一条日志说明用了陈旧数据，实际：${JSON.stringify(logs)}`,
  );
});

test("★ 没有缓存且上游失败 → 抛错（调用方决定要不要让页面空着）", async () => {
  await cleanup();
  await assert.rejects(
    withUpstreamCache({ namespace: NS, key: "none", ttlMs: 1000 }, async () => {
      throw new Error("上游挂了");
    }),
    /上游挂了/,
  );
});

test("★ 陈旧超过上界就不再返回 —— 不能拿很久以前的档期糊弄人", async () => {
  await cleanup();
  const ttlMs = 1000;
  await writeUpstreamCache(NS, "ancient", { v: 1 }, new Date(1_000_000));

  // 时间推进到超出 STALE_MAX_MS
  const now = 1_000_000 + STALE_MAX_MS + 1;
  const hit = await readUpstreamCache(NS, "ancient", ttlMs, now);
  assert.equal(hit, null, "超出陈旧上界应视为未命中");
});

test("过期后重新拉取并**更新**缓存（不是永远吃旧数据）", async () => {
  await cleanup();
  const ttlMs = 1000;
  let now = 5_000_000;
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { gen: calls };
  };
  const opts = { namespace: NS, key: "refresh", ttlMs, now: () => now };

  await withUpstreamCache(opts, loader);
  now += ttlMs + 1;
  const second = await withUpstreamCache(opts, loader);

  assert.equal(calls, 2, "过期后应重新拉取");
  assert.deepEqual(second, { gen: 2 });

  // 第三次仍在新的 TTL 内 → 不再拉取
  const third = await withUpstreamCache(opts, loader);
  assert.equal(calls, 2);
  assert.deepEqual(third, { gen: 2 });
});

test("键与命名空间互相隔离 —— 串了就是「A 的数据端给 B」", async () => {
  await cleanup();
  await writeUpstreamCache(NS, "k1", { who: "k1" }, new Date());
  await writeUpstreamCache(NS, "k2", { who: "k2" }, new Date());
  await writeUpstreamCache(`${NS}-other`, "k1", { who: "other" }, new Date());

  assert.deepEqual((await readUpstreamCache(NS, "k1", 60_000))?.value, { who: "k1" });
  assert.deepEqual((await readUpstreamCache(NS, "k2", 60_000))?.value, { who: "k2" });
  assert.deepEqual((await readUpstreamCache(`${NS}-other`, "k1", 60_000))?.value, {
    who: "other",
  });
});

test("数据损坏当作未命中（不抛错、不返回半个对象）", async () => {
  await cleanup();
  // 直接写入一段非 gzip 的垃圾
  await prisma.upstreamCache.create({
    data: { namespace: NS, key: "broken", payload: new Uint8Array([1, 2, 3, 4]) },
  });
  const hit = await readUpstreamCache(NS, "broken", 60_000);
  assert.equal(hit, null, "损坏的数据应视为未命中");

  // 且已被惰性删除
  const row = await prisma.upstreamCache.findUnique({
    where: { namespace_key: { namespace: NS, key: "broken" } },
  });
  assert.equal(row, null, "损坏条目应被顺带删掉");
});

test("gzip 往返：中文与大 payload 都正确", async () => {
  const payload = { title: "葬送的芙莉莲", items: Array.from({ length: 500 }, (_, i) => `第${i}集`) };
  const json = JSON.stringify(payload);
  const restored = decompressJson(compressJson(json));
  assert.equal(restored, json);
  // 压缩确实起作用（否则 500 条列表会白白占空间）
  assert.ok(compressJson(json).length < json.length, "gzip 应当变小");
});

test("统计按命名空间分组，便于运维观察配额用得对不对", async () => {
  await cleanup();
  await writeUpstreamCache(NS, "s1", { a: 1 });
  await writeUpstreamCache(NS, "s2", { a: 2 });
  const stats = await upstreamCacheStats();
  const mine = stats.find((s) => s.namespace === NS);
  assert.ok(mine, "统计里应包含测试命名空间");
  assert.equal(mine.entries, 2);
});

test("prune 只删超期条目，保留新鲜的", async () => {
  await cleanup();
  await writeUpstreamCache(NS, "old", { a: 1 }, new Date(Date.now() - STALE_MAX_MS - 60_000));
  await writeUpstreamCache(NS, "new", { a: 2 }, new Date());

  const removed = await pruneUpstreamCache();
  assert.ok(removed >= 1, "应删掉至少那条超期条目");

  const kept = await prisma.upstreamCache.findUnique({
    where: { namespace_key: { namespace: NS, key: "new" } },
  });
  assert.ok(kept, "新鲜条目必须保留");
});
