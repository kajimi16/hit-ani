/**
 * 清理过期的缓存（外部弹幕 + 上游响应）。
 *
 * 读路径已做惰性删除（访问到过期条目时顺带删掉），这里补全另一半：
 * **不再被访问**的条目只能靠定时任务清理。
 *
 * 建议加进 crontab，例如每天凌晨一次：
 *   0 3 * * * cd /opt/hit-ani && npm run cache:prune >> /var/log/hit-ani-cache.log 2>&1
 *
 * 运行：`npm run cache:prune`
 */

import { EXTERNAL_CACHE_TTL_MS } from "@/lib/danmaku/external";
import { danmakuCacheStats, pruneDanmakuCache } from "@/lib/danmaku/cache-repository";
import { pruneUpstreamCache, upstreamCacheStats } from "@/lib/cache/upstream-cache";
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

  // 外部弹幕
  const before = await danmakuCacheStats();
  const removed = await pruneDanmakuCache(EXTERNAL_CACHE_TTL_MS);
  const after = await danmakuCacheStats();
  console.log(
    `弹幕缓存：${before.episodes} 集 / ${mb(before.totalBytes)} MB` +
      ` → 删除 ${removed} 条 → ${after.episodes} 集 / ${mb(after.totalBytes)} MB`,
  );

  /*
   * 上游响应缓存（时间表 / 首页推荐）。
   *
   * 这里用**陈旧上界**（`pruneUpstreamCache()` 的默认值）而不是各自的 TTL：
   * 条目超过 TTL 但还没到上界时仍然有用 —— 上游偶发不可用时靠它兜底
   * （见 `withUpstreamCache`）。按 TTL 清会把这份「救命数据」提前删掉。
   */
  const statsBefore = await upstreamCacheStats();
  const upstreamRemoved = await pruneUpstreamCache();
  const statsAfter = await upstreamCacheStats();
  const summarize = (rows: typeof statsBefore) =>
    rows.length === 0 ? "0 项" : rows.map((r) => `${r.namespace} ${r.entries}`).join(" / ");
  console.log(
    `上游缓存：${summarize(statsBefore)} → 删除 ${upstreamRemoved} 条 → ${summarize(statsAfter)}`,
  );
}

main()
  .catch((error) => {
    console.error("清理失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
