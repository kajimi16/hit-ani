/**
 * 清理过期的外部弹幕缓存。
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
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  const before = await danmakuCacheStats();
  const removed = await pruneDanmakuCache(EXTERNAL_CACHE_TTL_MS);
  const after = await danmakuCacheStats();

  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);
  console.log(
    `缓存：${before.episodes} 集 / ${mb(before.totalBytes)} MB` +
      ` → 删除 ${removed} 条 → ${after.episodes} 集 / ${mb(after.totalBytes)} MB`,
  );
}

main()
  .catch((error) => {
    console.error("清理失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
