/**
 * 弹幕持久化缓存单测。
 *
 * 为什么需要它：外部弹幕的缓存是**上游的明确要求**（dandanplay 使用约定 §10
 * 要求缓存，并对调用量大的应用限流）。而内存 LRU 只有 40 集、TTL 5 分钟，
 * 重启即全失 —— 等于几乎每次都回源。落盘是解决这一点的唯一办法，
 * 因此它的压缩、TTL、损坏容错都必须有测试钉死。
 *
 * 这些测试需要数据库（走真实的 gzip + Prisma 读写）。
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  compressDanmaku,
  danmakuCacheStats,
  decompressDanmaku,
  pruneDanmakuCache,
  readDanmakuCache,
  writeDanmakuCache,
} from "@/lib/danmaku/cache-repository";

/**
 * 本文件专用的服务名前缀。
 *
 * `node --test` **并行**执行多个测试文件，而本表是共享的 ——
 * 若用固定的 `service` 名，另一个文件里的 `clearDanmakuCache()`
 * 会在本文件断言前把数据清掉（实测踩过：`undefined !== 3`）。
 *
 * 因此每个文件、每个用例都用独立命名空间，互不干扰。
 */
const NS = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const svc = (name: string) => `${NS}-${name}`;

/** 只清本命名空间的数据 —— 不动其他测试文件的行。 */
async function clearNamespace(): Promise<void> {
  await prisma.danmakuCache.deleteMany({ where: { service: { startsWith: NS } } });
}

/** 造一批弹幕，模拟真实数据。 */
function makeItems(count: number): { id: string; text: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `d${i}`,
    text: `第 ${i} 条弹幕内容，含一些常见网络用语`,
  }));
}

/* ---------------------------------------------------------------- *
 * 压缩
 * ---------------------------------------------------------------- */

test("gzip 往返后内容完全一致", () => {
  const json = JSON.stringify(makeItems(500));
  const compressed = compressDanmaku(json);
  const restored = decompressDanmaku(compressed);
  assert.equal(restored, json, "解压后必须与原文完全一致");
});

test("弹幕 JSON 压缩率显著（实测约 90%）", () => {
  // 弹幕文本高度重复（同样的字段结构、同一批网络用语），因此压缩率很高。
  // 这决定了「1 万集只占 0.5GB」这个结论是否成立。
  const json = JSON.stringify(makeItems(3000));
  const raw = Buffer.byteLength(json, "utf8");
  const compressed = compressDanmaku(json).length;
  const ratio = 1 - compressed / raw;

  assert.ok(ratio > 0.8, `压缩率仅 ${(ratio * 100).toFixed(0)}%，低于预期`);
  console.log(
    `     3000 条：${(raw / 1024).toFixed(0)} KB → ${(compressed / 1024).toFixed(0)} KB ` +
      `（压缩 ${(ratio * 100).toFixed(0)}%）`,
  );
});

test("解压损坏数据返回 null 而非抛错", () => {
  // 缓存损坏应表现为「回源重拉」，而不是让整集弹幕接口 500
  assert.equal(decompressDanmaku(new Uint8Array([1, 2, 3, 4])), null);
  assert.equal(decompressDanmaku(new Uint8Array([])), null);
});

/* ---------------------------------------------------------------- *
 * 读写
 * ---------------------------------------------------------------- */

test("写入后可读回，count 与 total 都保留", async () => {
  await clearNamespace();
  const items = makeItems(100);
  await writeDanmakuCache(svc("A"), 1001, { items, total: 4909 });

  const cached = await readDanmakuCache(svc("A"), 1001, 60_000);
  assert.ok(cached, "应命中缓存");
  assert.equal(cached.items.length, 100);
  assert.equal(cached.total, 4909, "真实总数必须保留（用于「共 N 条」提示）");
  assert.deepEqual(cached.items, items);

  await clearNamespace();
});

test("未写入的 key 返回 null（调用方应回源）", async () => {
  await clearNamespace();
  assert.equal(await readDanmakuCache(svc("A"), 99999, 60_000), null);
});

test("过期条目视为未命中，且被顺带清理", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("A"), 1002, { items: makeItems(5), total: 5 });

  // TTL 设为 0，立刻过期
  assert.equal(await readDanmakuCache(svc("A"), 1002, 0), null);

  // 惰性删除应已把它清掉（只数本命名空间 —— 全表可能有其他测试的数据）
  const remaining = await prisma.danmakuCache.count({ where: { service: svc("A") } });
  assert.equal(remaining, 0, "过期条目应被删除，而不是留在表里");
});

test("重复写入同一 key 是 upsert（不产生重复行）", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("A"), 1003, { items: makeItems(10), total: 10 });
  await writeDanmakuCache(svc("A"), 1003, { items: makeItems(20), total: 20 });

  const cached = await readDanmakuCache(svc("A"), 1003, 60_000);
  assert.equal(cached?.items.length, 20, "应是覆盖而非追加");
  const rows = await prisma.danmakuCache.count({ where: { service: svc("A") } });
  assert.equal(rows, 1, "同一 key 应只有一行");

  await clearNamespace();
});

test("不同 service + episodeId 相互隔离", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("B"), 2001, { items: makeItems(3), total: 3 });
  await writeDanmakuCache(svc("C"), 2001, { items: makeItems(7), total: 7 });

  assert.equal((await readDanmakuCache(svc("B"), 2001, 60_000))?.items.length, 3);
  assert.equal((await readDanmakuCache(svc("C"), 2001, 60_000))?.items.length, 7);

  await clearNamespace();
});

test("空结果也缓存（避免反复回源确认「确实没有」）", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("A"), 1004, { items: [], total: 0 });

  const cached = await readDanmakuCache(svc("A"), 1004, 60_000);
  assert.ok(cached, "空结果应能命中缓存");
  assert.equal(cached.items.length, 0);
  assert.equal(cached.total, 0);

  await clearNamespace();
});

/* ---------------------------------------------------------------- *
 * 运维
 * ---------------------------------------------------------------- */

test("pruneDanmakuCache 清理超过指定年龄的条目", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("A"), 1005, { items: makeItems(2), total: 2 });

  // 年龄设为 0 → 全部视为过期
  const removed = await pruneDanmakuCache(0);
  assert.equal(removed, 1);

  // 保留窗口很大 → 不该删任何东西
  await writeDanmakuCache(svc("A"), 1006, { items: makeItems(2), total: 2 });
  assert.equal(await pruneDanmakuCache(24 * 60 * 60 * 1000), 0);

  await clearNamespace();
});

test("danmakuCacheStats 报告条数与字节数", async () => {
  await clearNamespace();
  await writeDanmakuCache(svc("A"), 1007, { items: makeItems(500), total: 500 });

  const stats = await danmakuCacheStats();
  assert.ok(stats.episodes >= 1, "至少含本用例写入的那条");
  assert.ok(stats.totalBytes > 0, "应报告压缩后的字节数");
  console.log(`     全表 ${stats.episodes} 集 / ${(stats.totalBytes / 1024).toFixed(1)} KB`);

  await clearNamespace();
});
