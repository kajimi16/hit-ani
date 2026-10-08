/**
 * 上游响应的通用缓存。
 *
 * ## 解决什么
 *
 * 有些页面**每次访问都打上游** —— 最典型的是时间表（按周查 BGM 档期）。
 * 上游有配额也会限流，而这类数据变化很慢（一周的档期不会按分钟变）。
 * 每次访问都回源的结果是：**配额被日常浏览吃掉**，真正需要新鲜数据时反而没得用。
 *
 * ## 三条设计决定
 *
 * 1. **落库而不是只放内存。**
 *    进程内缓存（像媒体资源那样）重启即失效，而容器重建/重启在这里是常态
 *    （`docker compose up -d`、改配置、部署新版本）。落库才真正省下配额。
 *
 * 2. **上游失败时吃**陈旧**数据。**
 *    这个部署的上游经常不可用（校园网 + 代理链路）。时间表现在是
 *    `.catch(() => null)` → 整页空档期表。**稍旧的数据几乎总是比空页面有用**。
 *    但陈旧有上界（`STALE_MAX_MS`）—— 一周前的档期表已经没有意义了。
 *
 * 3. **键由调用方定，模块不猜。**
 *    「什么算同一份响应」是业务语义（周次、NSFW 偏好、条目类型…），
 *    模块只负责 `namespace + key → JSON` 的存取。
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { prisma } from "@/lib/prisma";

/**
 * 陈旧数据的最长可用时间（上游失败时）。
 *
 * 取 3 天：比任何 TTL 都长得多（所以常规情况下它不起作用），
 * 又短到「不至于拿一个月前的档期糊弄人」。
 */
export const STALE_MAX_MS = 3 * 24 * 60 * 60 * 1000;

export interface CacheHit<T> {
  value: T;
  /** 写入时间，调用方可用于展示「数据截至 …」 */
  fetchedAt: Date;
  /** 是否已超过 TTL（仅在上游失败时才会返回 true） */
  stale: boolean;
}

/** 压缩 / 解压。与弹幕缓存同一套做法（gzip）。 */
export function compressJson(json: string): Uint8Array<ArrayBuffer> {
  // `Uint8Array` 的底层 buffer 类型在 Node 与 DOM 之间不一致，
  // Prisma 的 Bytes 字段要的是 `Uint8Array<ArrayBuffer>` —— 显式转换。
  return new Uint8Array(gzipSync(json));
}

export function decompressJson(payload: Uint8Array): string | null {
  try {
    return gunzipSync(payload).toString("utf8");
  } catch {
    // 数据损坏（例如半写入）—— 当作未命中，调用方会重新拉取
    return null;
  }
}

/**
 * 读取缓存。
 *
 * `ttlMs` 之内算新鲜；`ttlMs` 到 `STALE_MAX_MS` 之间算**陈旧**（仅在
 * 上游失败时由 `withUpstreamCache` 使用，调用方不会直接拿到）。
 */
export async function readUpstreamCache<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  now = Date.now(),
): Promise<CacheHit<T> | null> {
  const row = await prisma.upstreamCache.findUnique({
    where: { namespace_key: { namespace, key } },
  });
  if (!row) return null;

  const age = now - row.fetchedAt.getTime();

  // 超出陈旧上界：删掉，当作未命中
  if (age > STALE_MAX_MS) {
    await prisma.upstreamCache
      .delete({ where: { namespace_key: { namespace, key } } })
      .catch(() => undefined);
    return null;
  }

  const json = decompressJson(row.payload);
  if (json === null) {
    await prisma.upstreamCache
      .delete({ where: { namespace_key: { namespace, key } } })
      .catch(() => undefined);
    return null;
  }

  let value: T;
  try {
    value = JSON.parse(json) as T;
  } catch {
    return null;
  }

  return { value, fetchedAt: row.fetchedAt, stale: age > ttlMs };
}

/** 写入缓存（upsert，可重复执行）。 */
export async function writeUpstreamCache(
  namespace: string,
  key: string,
  value: unknown,
  now = new Date(),
): Promise<void> {
  const payload = compressJson(JSON.stringify(value));
  await prisma.upstreamCache.upsert({
    where: { namespace_key: { namespace, key } },
    create: { namespace, key, payload, fetchedAt: now },
    update: { payload, fetchedAt: now },
  });
}

export interface WithCacheOptions {
  namespace: string;
  key: string;
  ttlMs: number;
  /** 日志出口，便于测试与结构化收集。默认 `console.warn`。 */
  log?: (message: string) => void;
  /** 注入时钟，便于测试 TTL/陈旧行为。 */
  now?: () => number;
}

/**
 * 取缓存；没有或已过期就调 `loader` 并写回。
 *
 * 失败时的顺序（这是本模块最重要的行为）：
 *
 * 1. 缓存**新鲜** → 直接用，**根本不调 loader**（省配额就靠这一步）；
 * 2. 缓存过期或没有 → 调 loader；
 * 3. loader 抛错 → 若还有**陈旧**数据就返回它并记一条日志，否则把错误抛出去
 *    （调用方决定要不要让页面空着）。
 */
export async function withUpstreamCache<T>(
  options: WithCacheOptions,
  loader: () => Promise<T>,
): Promise<T> {
  const { namespace, key, ttlMs } = options;
  const log = options.log ?? ((message: string) => console.warn(message));
  const now = options.now ?? (() => Date.now());

  const hit = await readUpstreamCache<T>(namespace, key, ttlMs, now());
  if (hit && !hit.stale) return hit.value;

  try {
    const fresh = await loader();
    // 写失败不该影响本次响应 —— 数据是对的，只是这次没缓存上
    await writeUpstreamCache(namespace, key, fresh, new Date(now())).catch((error: unknown) => {
      log(`[upstream-cache] 写入失败（不影响本次响应）${namespace}/${key}: ${String(error)}`);
    });
    return fresh;
  } catch (error) {
    if (hit) {
      const ageMinutes = Math.round((now() - hit.fetchedAt.getTime()) / 60_000);
      log(
        `[upstream-cache] 上游失败，改用 ${ageMinutes} 分钟前的陈旧数据（${namespace}/${key}）：${String(error)}`,
      );
      return hit.value;
    }
    throw error;
  }
}

/**
 * 清理超期条目。惰性删除已覆盖读路径，这里补全「不再被访问」的条目。
 *
 * 返回删除条数。
 */
export async function pruneUpstreamCache(maxAgeMs = STALE_MAX_MS): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const result = await prisma.upstreamCache.deleteMany({
    where: { fetchedAt: { lt: cutoff } },
  });
  return result.count;
}

/** 缓存规模，供运维观察（按命名空间分组）。 */
export async function upstreamCacheStats(): Promise<
  { namespace: string; entries: number; oldest: Date | null }[]
> {
  const grouped = await prisma.upstreamCache.groupBy({
    by: ["namespace"],
    _count: { _all: true },
    _min: { fetchedAt: true },
  });
  return grouped.map((row) => ({
    namespace: row.namespace,
    entries: row._count._all,
    oldest: row._min.fetchedAt ?? null,
  }));
}
