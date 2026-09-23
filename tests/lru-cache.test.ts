/**
 * TTL + LRU 缓存单测。
 *
 * 容量上限是「外部弹幕不把常驻进程撑爆」的唯一保障 ——
 * 实测单集 0.92 MB，无上限时会随访问过的集数持续增长。
 * 因此淘汰行为必须有测试钉死。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlLruCache } from "@/lib/danmaku/lru-cache";

/** 可控时钟，用于测 TTL 而不用真等。 */
function makeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("基本读写", () => {
  const cache = new TtlLruCache<string>({ maxSize: 3, ttlMs: 1000 });
  assert.equal(cache.get("missing"), null);
  cache.set("a", "A");
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.size, 1);
});

test("超过 maxSize 时淘汰最久未使用的条目", () => {
  const cache = new TtlLruCache<number>({ maxSize: 3, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  assert.equal(cache.size, 3);

  cache.set("d", 4); // 应淘汰 a
  assert.equal(cache.get("a"), null, "a 是最久未使用的，应被淘汰");
  assert.equal(cache.get("b"), 2);
  assert.equal(cache.get("d"), 4);
  assert.equal(cache.size, 3, "容量不得超出上限");
});

test("读取会刷新「最近使用」位置，避免被误淘汰", () => {
  const cache = new TtlLruCache<number>({ maxSize: 3, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);

  // 访问 a —— 它应从此不再是最久未使用的
  assert.equal(cache.get("a"), 1);

  cache.set("d", 4); // 现在最久未使用的是 b
  assert.equal(cache.get("b"), null, "b 应被淘汰（a 因刚被访问而保留）");
  assert.equal(cache.get("a"), 1);
});

test("TTL 过期后读取返回 null 并移除条目", () => {
  const clock = makeClock();
  const cache = new TtlLruCache<string>({ maxSize: 10, ttlMs: 1000, now: clock.now });

  cache.set("a", "A");
  assert.equal(cache.get("a"), "A");

  clock.advance(999);
  assert.equal(cache.get("a"), "A", "未到 TTL 不应过期");

  clock.advance(2);
  assert.equal(cache.get("a"), null, "超过 TTL 应过期");
  assert.equal(cache.size, 0, "过期条目应被移除而不是留在表里");
});

test("覆盖同一 key 不增加条目数", () => {
  const cache = new TtlLruCache<number>({ maxSize: 5, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("a", 2);
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), 2);
});

test("淘汰计数可用于观察容量是否吃紧", () => {
  const cache = new TtlLruCache<number>({ maxSize: 2, ttlMs: 60_000 });
  assert.equal(cache.evictionCount, 0);

  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3); // 淘汰 1 个
  cache.set("d", 4); // 淘汰 1 个

  assert.equal(cache.evictionCount, 2);
});

test("clear 清空但保留累计统计", () => {
  const cache = new TtlLruCache<number>({ maxSize: 2, ttlMs: 60_000 });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("c", 3);
  const before = cache.evictionCount;

  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.evictionCount, before, "clear 不该重置累计统计");
});

test("拒绝非法构造参数（配置错误应立刻暴露）", () => {
  assert.throws(() => new TtlLruCache({ maxSize: 0, ttlMs: 1000 }), /maxSize/);
  assert.throws(() => new TtlLruCache({ maxSize: 10, ttlMs: 0 }), /ttlMs/);
});

test("maxSize=1 的极端情况仍能工作", () => {
  const cache = new TtlLruCache<string>({ maxSize: 1, ttlMs: 60_000 });
  cache.set("a", "A");
  cache.set("b", "B");
  assert.equal(cache.size, 1);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("b"), "B");
});

test("长时间运行不会无界增长（模拟连续访问 500 集）", () => {
  const cache = new TtlLruCache<number>({ maxSize: 40, ttlMs: 60_000 });

  for (let i = 0; i < 500; i += 1) cache.set(`ep-${i}`, i);

  assert.equal(cache.size, 40, "容量必须稳定在上限，而不是随访问量增长");
  assert.equal(cache.evictionCount, 460, "淘汰次数应等于超出部分");
  // 最近写入的应保留
  assert.equal(cache.get("ep-499"), 499);
  assert.equal(cache.get("ep-0"), null, "最早的应已被淘汰");
});
