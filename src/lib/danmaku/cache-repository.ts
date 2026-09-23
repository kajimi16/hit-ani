/**
 * 外部弹幕的持久化缓存。
 *
 * 分两层，各有分工：
 *
 * | 层 | 存活期 | 作用 |
 * | --- | --- | --- |
 * | 内存（`TtlLruCache`，见 external.ts） | 进程内，40 集 | 挡住同一集的高频重复请求 |
 * | **本模块（数据库）** | 按 TTL，可跨重启 | 挡住回源，满足上游的缓存要求 |
 *
 * 为什么必须落盘：dandanplay 的使用约定明确要求缓存，并会对调用量大的应用限流。
 * 网关每次重启都全量回源是明确的风险 —— 而且内存 LRU 只有 40 集、TTL 5 分钟，
 * 实际上几乎每次都回源。
 *
 * 为什么放数据库而不是外挂硬盘：gzip 后 1 万集仅 0.5GB，远小于视频；
 * 放数据库能随其余数据一起备份，也不受外挂盘掉线影响。
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { prisma } from "@/lib/prisma";

/** 缓存条目。与 `external.ts` 的 `SourceDanmaku` 结构一致。 */
export interface CachedDanmaku {
  items: unknown[];
  total: number;
}

/**
 * 弹幕 JSON 的压缩 / 解压。
 *
 * 弹幕文本高度重复（同一批网络用语、同样的字段结构），gzip 实测 **94% 压缩率**
 * （0.89MB → 56KB）。因此存进去前压缩，能显著降低数据库体积。
 *
 * 解压失败时返回 null 而不是抛错 —— 缓存损坏应当表现为「回源重拉」，
 * 而不是让整集弹幕接口 500。
 */
export function compressDanmaku(json: string): Uint8Array<ArrayBuffer> {
  // 返回 Uint8Array<ArrayBuffer> 而非 Buffer —— Prisma 的 Bytes 要求前者。
  // Buffer 的底层可能是 SharedArrayBuffer，类型上不兼容。
  return new Uint8Array(gzipSync(Buffer.from(json, "utf8"), { level: 6 }));
}

export function decompressDanmaku(payload: Uint8Array): string | null {
  try {
    return gunzipSync(Buffer.from(payload)).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 读取缓存。未命中、已过期或数据损坏时返回 null（调用方应回源）。
 *
 * 过期的条目**顺带删除** —— 惰性清理，避免额外的定时任务。
 */
export async function readDanmakuCache(
  service: string,
  episodeId: number,
  ttlMs: number,
): Promise<CachedDanmaku | null> {
  const row = await prisma.danmakuCache.findUnique({
    where: { service_episodeId: { service, episodeId } },
  });
  if (!row) return null;

  if (Date.now() - row.fetchedAt.getTime() > ttlMs) {
    // 惰性删除：过期即清，省掉定时任务
    await prisma.danmakuCache
      .delete({ where: { service_episodeId: { service, episodeId } } })
      .catch(() => undefined);
    return null;
  }

  const json = decompressDanmaku(row.payload);
  if (json === null) {
    // 数据损坏：删掉并当作未命中，下次会重新拉取
    await prisma.danmakuCache
      .delete({ where: { service_episodeId: { service, episodeId } } })
      .catch(() => undefined);
    return null;
  }

  try {
    return { items: JSON.parse(json) as unknown[], total: row.total };
  } catch {
    return null;
  }
}

/** 写入缓存（upsert，可重复执行）。 */
export async function writeDanmakuCache(
  service: string,
  episodeId: number,
  data: CachedDanmaku,
): Promise<void> {
  const payload = compressDanmaku(JSON.stringify(data.items));
  const fields = {
    payload,
    count: data.items.length,
    total: data.total,
    fetchedAt: new Date(),
  };
  await prisma.danmakuCache.upsert({
    where: { service_episodeId: { service, episodeId } },
    create: { service, episodeId, ...fields },
    update: fields,
  });
}

/**
 * 清理过期条目。供定时任务调用（惰性删除已覆盖读路径，这里补全「不再被访问」的条目）。
 *
 * 返回删除条数。
 */
export async function pruneDanmakuCache(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await prisma.danmakuCache.deleteMany({
    where: { fetchedAt: { lt: cutoff } },
  });
  return result.count;
}

/** 缓存规模，供运维观察。 */
export async function danmakuCacheStats(): Promise<{
  episodes: number;
  totalBytes: number;
}> {
  const rows = await prisma.danmakuCache.findMany({
    select: { payload: true },
  });
  return {
    episodes: rows.length,
    totalBytes: rows.reduce((sum, row) => sum + row.payload.length, 0),
  };
}

/** 清空缓存（运维用，例如上游数据出问题需要强制刷新）。 */
export async function clearDanmakuCache(): Promise<number> {
  const result = await prisma.danmakuCache.deleteMany({});
  return result.count;
}
