/**
 * 生成媒体库选片清单。
 *
 * 两条标准（详见 `src/lib/media/curation.ts`）：
 *   1. **有人观看过** —— 本地库里有「看过 / 在看」收藏，或存在单集观看进度
 *   2. **本季高分** —— 当前季度播出且 Bangumi 评分 > 阈值（默认 7）
 *
 * 输出清单供人工/脚本去获取资源 —— **本脚本不下载任何内容**。
 * 它只回答「该收哪些」，与「资源从哪来」是两件事。
 *
 * 运行：`npm run media:curation [-- --mb-per-episode=500 --min-score=7]`
 * 产出：`data/curation.json`（机器可读）+ 终端清单（人工可读）
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { prisma } from "@/lib/prisma";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";
import {
  CurationReason,
  estimateStorage,
  mergeCuration,
  seasonOf,
  sortForAcquisition,
  withReason,
  type CurationEntry,
  type CurationInput,
} from "@/lib/media/curation";

const arg = (name: string, fallback: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** 每集平均体积（MB）。1080p WEB-DL 约 500MB，BDRip 约 1200MB。 */
const MB_PER_EPISODE = arg("mb-per-episode", 500);
const MIN_SCORE = arg("min-score", 7);
const OUTPUT = "data/curation.json";
/** 外挂硬盘可用空间（GB）。用于核算清单能否放得下。 */
const AVAILABLE_GB = arg("available-gb", 418);

/**
 * 标准一：本地库里有人观看过的番。
 *
 * 判定用两个信号：
 * - 收藏类型为「看过(2) / 在看(3)」—— 明确的观看意图
 * - 存在单集观看进度 —— 实际看过
 *
 * 「想看(1)」不算：「想看」只是意图，而库容有限，优先收已被证明的需求。
 */
async function collectWatched(): Promise<CurationInput[]> {
  const collections = await prisma.collection.findMany({
    where: { type: { in: [2, 3] } },
    select: {
      subject: {
        select: {
          id: true,
          name: true,
          nameCn: true,
          score: true,
          airDate: true,
          _count: { select: { episodes: true } },
        },
      },
    },
  });

  // 有单集进度的条目（即使收藏状态是「想看」，实际看过也算）
  const withProgress = await prisma.episode.findMany({
    where: { progress: { some: {} } },
    distinct: ["subjectId"],
    select: {
      subject: {
        select: {
          id: true,
          name: true,
          nameCn: true,
          score: true,
          airDate: true,
          _count: { select: { episodes: true } },
        },
      },
    },
  });

  const byId = new Map<number, CurationInput>();
  const push = (s: {
    id: number;
    name: string;
    nameCn: string | null;
    score: number | null;
    airDate: Date | null;
    _count: { episodes: number };
  }): void => {
    if (byId.has(s.id)) return;
    byId.set(s.id, {
      subjectId: s.id,
      name: s.name,
      nameCn: s.nameCn,
      score: s.score,
      // 本地章节数为 0 说明只缓存了轻量数据；此时集数未知
      episodes: s._count.episodes > 0 ? s._count.episodes : null,
      airDate: s.airDate ? s.airDate.toISOString().slice(0, 10) : null,
    });
  };

  for (const row of collections) if (row.subject) push(row.subject);
  for (const row of withProgress) if (row.subject) push(row.subject);

  return [...byId.values()];
}

/**
 * 标准二：本季高分番。
 *
 * 必须查 BGM —— 本地只缓存用户交互过的条目，其中当季番只有个位数。
 * 分页拉取，因为一季可能有几百部。
 */
async function collectSeasonTopRated(): Promise<CurationInput[]> {
  const season = seasonOf(new Date());
  console.log(`  季度范围：${season.label}（${season.start} ~ ${season.end}）`);

  const all: CurationInput[] = [];
  const PAGE = 50;
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;

  while (offset < total) {
    const page = await searchSubjects(
      {
        keyword: "",
        sort: "heat",
        filter: {
          type: [SubjectType.Anime] as never,
          air_date: [`>=${season.start}`, `<=${season.end}`],
          rating: [`>=${MIN_SCORE}`],
          nsfw: false,
        },
      },
      { limit: PAGE, offset },
    );

    total = page.total;
    for (const item of page.data) {
      all.push({
        subjectId: item.id,
        name: item.name,
        nameCn: item.name_cn,
        score: item.rating?.score ?? null,
        episodes: item.eps ?? null,
        airDate: item.date ?? null,
      });
    }

    offset += PAGE;
    if (page.data.length === 0) break;
  }

  console.log(`  本季评分 ≥ ${MIN_SCORE}：${all.length} 部（上游计 ${total}）`);
  return all;
}

async function main(): Promise<void> {
  console.log("=== 媒体库选片清单 ===\n");

  console.log("1. 标准一：有人观看过（本地库）");
  const watched = await collectWatched();
  console.log(`  ${watched.length} 部\n`);

  console.log("2. 标准二：本季高分（BGM 实时查询）");
  const season = await collectSeasonTopRated();
  console.log();

  // 合并去重：同一部番可能同时命中两条标准
  const merged = mergeCuration([...watched, ...season]);
  const watchedIds = new Set(watched.map((item) => item.subjectId));
  const seasonIds = new Set(season.map((item) => item.subjectId));

  let entries: CurationEntry[] = withReason(merged, watchedIds, CurationReason.Watched);
  entries = withReason(entries, seasonIds, CurationReason.SeasonTopRated);

  const sorted = sortForAcquisition(entries);
  const storage = estimateStorage(sorted, MB_PER_EPISODE);

  // ---------------------------------------------------------------- 汇总
  const both = sorted.filter((e) => e.reasons.length === 2).length;
  const onlyWatched = sorted.filter(
    (e) => e.reasons.length === 1 && e.reasons[0] === CurationReason.Watched,
  ).length;
  const onlySeason = sorted.filter(
    (e) => e.reasons.length === 1 && e.reasons[0] === CurationReason.SeasonTopRated,
  ).length;

  console.log("=== 结果 ===");
  console.log(`  合计 ${sorted.length} 部`);
  console.log(`    仅「看过/在看」  ${onlyWatched}`);
  console.log(`    仅「本季高分」    ${onlySeason}`);
  console.log(`    两条都命中        ${both}`);
  console.log();
  console.log(`  已知集数合计 ${storage.totalEpisodes} 集`);
  console.log(
    `  按 ${MB_PER_EPISODE} MB/集估算需 ${storage.totalGb} GB` +
      `（可用 ${AVAILABLE_GB} GB）` +
      (storage.totalGb > AVAILABLE_GB ? "  ⚠ 超出可用空间" : "  ✔ 放得下"),
  );
  console.log(
    `  注：有 ${sorted.filter((e) => e.episodes === null).length} 部集数未知` +
      "（只缓存了轻量数据），未计入估算",
  );

  /*
   * 容量感知：标准（观看记录 + 本季高分）产生的候选池通常**远大于**可用空间 ——
   * 实测 398 部需约 3070 GB，而硬盘只有 418 GB（7 倍差距）。
   *
   * 因此清单不是「一次性收完」的清单，而是**按优先级排队的候选池**：
   * 按评分降序收，收满即止。这里算出「当前空间能收多少」并给出批次。
   */
  const fits: typeof sorted = [];
  let usedGb = 0;
  for (const entry of sorted) {
    const gb = ((entry.episodes ?? 0) * MB_PER_EPISODE) / 1024;
    if (usedGb + gb > AVAILABLE_GB) break;
    fits.push(entry);
    usedGb += gb;
  }

  console.log(`
=== 按当前空间（${AVAILABLE_GB} GB）分批 ===`);
  console.log(
    `  第一批可收 ${fits.length} 部 / ${usedGb.toFixed(0)} GB` +
      `（评分 ≥ ${fits.at(-1)?.score?.toFixed(1) ?? "--"}）`,
  );
  console.log(`  剩余 ${sorted.length - fits.length} 部留待扩容或第二批`);

  // ---------------------------------------------------------------- 清单
  console.log("\n=== 清单（按评分降序）===");
  for (const entry of sorted.slice(0, 40)) {
    const tags = entry.reasons
      .map((r) => (r === CurationReason.Watched ? "看过" : "本季高分"))
      .join("+");
    const score = entry.score !== null ? entry.score.toFixed(1) : " -- ";
    const eps = entry.episodes !== null ? `${entry.episodes}集` : " ?集";
    console.log(`  ${score}  ${eps.padStart(5)}  [${tags}]  ${entry.folderName}`);
  }
  if (sorted.length > 40) console.log(`  … 另有 ${sorted.length - 40} 部，见输出文件`);

  // ---------------------------------------------------------------- 落盘
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(
    OUTPUT,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        criteria: { minScore: MIN_SCORE, season: seasonOf(new Date()), mbPerEpisode: MB_PER_EPISODE },
        estimate: { ...storage, availableGb: AVAILABLE_GB },
        /** 当前空间能收下的子集（按评分降序截取） */
        fitsInAvailable: fits.map((e) => e.subjectId),
        /** 全部候选，按优先级（评分降序）排列 */
        entries: sorted,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\n清单已写入 ${OUTPUT}`);
  console.log(
    "该文件不含任何资源，只有「该收哪些」—— 获取方式由部署方决定（见 docs/MEDIA.md §6.4）。",
  );
}

main()
  .catch((error) => {
    console.error("生成失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
