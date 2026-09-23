/**
 * 端到端探测：搜索 → 详情页 → 剧集 → 播放页 → 视频直链。
 *
 * 这一步才决定「能不能在线看」——搜索通了只说明能找到条目，
 * 真正关键的是最后能不能拿到可播放的地址。
 *
 * 运行：`npm run sources:probe [-- --keyword=魔法少女 --limit=5]`
 */

import { prisma } from "@/lib/prisma";
import { fetchEpisodesFor, listSources, resolveVideoFor, searchAllSources } from "@/lib/media/service";
import { clearResourceCache } from "@/lib/media/resource-service";

const KEYWORD = process.argv.find((a) => a.startsWith("--keyword="))?.split("=")[1] ?? "魔法少女";
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 5);

async function main(): Promise<void> {
  clearResourceCache();
  const sources = (await listSources(true)).filter((s) => s.factory === "web-selector");
  console.log(`探测 ${sources.length} 个 web-selector 源，关键词「${KEYWORD}」\n`);

  const results = await searchAllSources(KEYWORD, { maxResultsPerSource: LIMIT });

  let chainOk = 0;
  let videoOk = 0;

  for (const result of results) {
    if (!result.ok || result.items.length === 0) {
      console.log(`✘ ${result.sourceName.padEnd(12)} 搜索无结果`);
      continue;
    }

    const detailUrl = result.items[0].url;
    console.log(`\n── ${result.sourceName} ──`);
    console.log(`  搜索: ${result.items[0].name.slice(0, 50)}`);
    console.log(`  详情: ${detailUrl.slice(0, 90)}`);

    // 1) 详情页 → 剧集
    const episodes = await fetchEpisodesFor(result.sourceId, detailUrl);
    if (!episodes.ok || episodes.items.length === 0) {
      console.log(`  ✘ 剧集: ${episodes.error ?? `命中 ${episodes.diagnostics?.matchedElements ?? 0} 个元素但未提取到`}`);
      continue;
    }
    chainOk += 1;
    console.log(`  ✔ 剧集: ${episodes.items.length} 集，首个「${episodes.items[0].name.slice(0, 40)}」`);

    // 2) 播放页 → 视频直链
    const video = await resolveVideoFor(result.sourceId, episodes.items[0].url);
    if (!video.ok || !video.videoUrl) {
      console.log(`  ✘ 直链: ${video.error}`);
      continue;
    }
    videoOk += 1;
    console.log(`  ✔ 直链: ${video.videoUrl.slice(0, 110)}`);
    if (video.trail.length > 1) {
      console.log(`     途经 ${video.trail.length} 个页面`);
    }
  }

  console.log(`\n=== 汇总 ===`);
  console.log(`  搜索可用: ${results.filter((r) => r.ok && r.items.length > 0).length}/${results.length}`);
  console.log(`  剧集可用: ${chainOk}`);
  console.log(`  直链可用: ${videoOk}`);
}

main()
  .catch((error) => {
    console.error("探测失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
