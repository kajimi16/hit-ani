/**
 * 「轻量导入 + 访问时补齐」策略验证。
 *
 * 核心要验证的是**请求量** —— 这是这次改造的全部意义：
 *
 * | 阶段 | 早先实现 | 现在 |
 * | --- | --- | --- |
 * | 导入 377 个收藏 | 上千次请求、447 秒 | ⌈377/100⌉ = 4 次 |
 * | 打开某个条目 | 0（已全部导完） | 3 次（详情 + 章节 + 进度） |
 *
 * 所以本脚本统计真实发生的上游请求次数，而不只是"跑通了"。
 * 用桩替换上游，因此不依赖网络，也不会消耗 BGM 配额。
 *
 * 运行：`npm run import-check`
 */

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import { enrichSubject, importUserLibrary } from "@/lib/bgm/import";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✘ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const REAL_FETCH = globalThis.fetch;

/** 统计桩拦截到的上游请求，按路径分类。 */
interface RequestLog {
  collections: number;
  subjects: number;
  episodes: number;
  progress: number;
  total: number;
}

const log: RequestLog = { collections: 0, subjects: 0, episodes: 0, progress: 0, total: 0 };

function resetLog(): void {
  log.collections = 0;
  log.subjects = 0;
  log.episodes = 0;
  log.progress = 0;
  log.total = 0;
}

const SUBJECT_COUNT = 250;
const EPISODES_PER_SUBJECT = 3;

/** 桩：250 个收藏、每个 3 集、每个 1 条进度。 */
function stubUpstream(): void {
  const ids = Array.from({ length: SUBJECT_COUNT }, (_, i) => 800_000 + i);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.total += 1;

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    // 收藏列表 —— 内嵌 SlimSubject（这正是「轻量导入」的依据）
    if (url.includes("/collections?")) {
      log.collections += 1;
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const slice = ids.slice(offset, offset + limit);
      return json({
        total: ids.length,
        limit,
        offset,
        data: slice.map((id, i) => {
          const index = offset + i;
          return {
            subject_id: id,
            subject_type: 2,
            rate: (index % 11) + 1,
            type: (index % 3) + 1,
            comment: null,
            tags: [],
            ep_status: 0,
            vol_status: 0,
            updated_at: new Date().toISOString(),
            private: false,
            // 列表接口内嵌的轻量条目数据
            subject: {
              id,
              type: 2,
              name: `Stub ${id}`,
              name_cn: `桩条目 ${id}`,
              short_summary: `截短简介 ${id}`,
              images: {
                large: `https://lain.bgm.tv/large/${id}.jpg`,
                common: `https://lain.bgm.tv/common/${id}.jpg`,
              },
              eps: EPISODES_PER_SUBJECT,
              collection_total: 100,
              score: 7.5,
              rank: 100 + index,
              tags: [{ name: "测试", count: 1, total_count: 1 }],
            },
          };
        }),
      });
    }

    // 条目详情
    const subjectMatch = /\/v0\/subjects\/(\d+)/.exec(url);
    if (subjectMatch) {
      log.subjects += 1;
      const id = Number(subjectMatch[1]);
      return json({
        id,
        type: 2,
        name: `Stub ${id}`,
        name_cn: `桩条目 ${id}`,
        // 完整简介（轻量数据里只有短版本）
        summary: `完整简介 ${id} —— 这一段在导入时不会拉取`,
        series: false,
        nsfw: false,
        locked: false,
        date: "2020-01-01",
        platform: "",
        images: { large: `https://lain.bgm.tv/large/${id}.jpg` },
        volumes: 0,
        eps: EPISODES_PER_SUBJECT,
        total_episodes: EPISODES_PER_SUBJECT,
        rating: { rank: 100, total: 10, count: {}, score: 7.5 },
      });
    }

    // 章节列表
    if (url.includes("/v0/episodes?")) {
      log.episodes += 1;
      const parsed = new URL(url);
      const subjectId = Number(parsed.searchParams.get("subject_id"));
      return json({
        total: EPISODES_PER_SUBJECT,
        limit: 100,
        offset: 0,
        data: Array.from({ length: EPISODES_PER_SUBJECT }, (_, i) => ({
          id: subjectId * 10 + i + 1,
          type: 0,
          name: `EP${i + 1}`,
          name_cn: `第 ${i + 1} 话`,
          sort: i + 1,
          ep: i + 1,
          airdate: "2020-01-01",
          comment: 0,
          duration: "24m",
          desc: "",
          disc: 0,
        })),
      });
    }

    // 单集进度
    if (url.includes("/collections/") && url.includes("/episodes")) {
      log.progress += 1;
      const subjectId = Number(/\/collections\/(\d+)\/episodes/.exec(new URL(url).pathname)?.[1]);
      return json({
        total: 1,
        limit: 100,
        offset: 0,
        data: [
          {
            episode: {
              id: subjectId * 10 + 1,
              type: 0,
              name: "EP1",
              name_cn: "第 1 话",
              sort: 1,
              airdate: "2020-01-01",
              comment: 0,
              duration: "24m",
              desc: "",
              disc: 0,
            },
            type: 2,
            updated_at: 0,
          },
        ],
      });
    }

    throw new Error(`未预期的上游请求: ${url}`);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  console.log("=== 轻量导入 + 访问时补齐 验证（上游打桩）===\n");

  const user = await prisma.user.create({
    data: {
      email: `importcheck-${Date.now()}@hit.edu.cn`,
      nickname: "导入验证",
      passwordHash: await hashPassword("importcheck-password"),
      schoolId: "hit",
    },
    select: { id: true },
  });

  try {
    stubUpstream();
    resetLog();

    // ---------------------------------------------------------------- 导入
    console.log(`1. 导入 ${SUBJECT_COUNT} 个收藏（只写轻量数据）`);
    const stats = await importUserLibrary(user.id, {
      username: "stub_user",
      accessToken: "stub-token",
    });

    check(`条目数 = ${SUBJECT_COUNT}`, stats.subjects === SUBJECT_COUNT, stats.subjects);
    check(`收藏数 = ${SUBJECT_COUNT}`, stats.collections === SUBJECT_COUNT, stats.collections);
    check("首次导入全部为新建", stats.created === SUBJECT_COUNT && stats.updated === 0, stats);

    // ★ 核心指标：请求量应约等于页数，而不是收藏数
    const expectedPages = Math.ceil(SUBJECT_COUNT / 100);
    console.log(`     上游请求：收藏列表 ${log.collections} 次 · 条目详情 ${log.subjects} 次 · ` +
      `章节 ${log.episodes} 次 · 进度 ${log.progress} 次（共 ${log.total}）`);
    check(
      `只打了 ⌈${SUBJECT_COUNT}/100⌉ = ${expectedPages} 次收藏列表请求`,
      log.collections === expectedPages,
      log.collections,
    );
    check("导入阶段**不**拉条目详情", log.subjects === 0, log.subjects);
    check("导入阶段**不**拉章节", log.episodes === 0, log.episodes);
    check("导入阶段**不**拉进度", log.progress === 0, log.progress);

    // ---------------------------------------------------------------- 轻量数据质量
    console.log("\n2. 轻量数据足以渲染列表");
    // 必须按具体 ID 查 —— 用 findFirst 会拿到本地库里已有的真实条目
    const sample = await prisma.subject.findUnique({
      where: { id: 800_000 },
      select: { nameCn: true, coverUrl: true, score: true, rank: true, tags: true, summary: true, detailSyncedAt: true },
    });
    check("有中文名", Boolean(sample?.nameCn), sample?.nameCn);
    check("有封面", Boolean(sample?.coverUrl), sample?.coverUrl);
    check("有评分与排名", sample?.score !== null && sample?.rank !== null);
    check("标签已从对象数组拍平为字符串", Array.isArray(sample?.tags) && typeof sample?.tags[0] === "string", sample?.tags);
    check("有截短简介", Boolean(sample?.summary));
    check("detailSyncedAt 仍为 null（还没拉过详情）", sample?.detailSyncedAt === null, sample?.detailSyncedAt);

    // ---------------------------------------------------------------- 访问时补齐
    console.log("\n3. 打开某个条目时才拉详情");
    resetLog();
    const targetId = 800_000;
    const enriched = await enrichSubject(targetId, { userId: user.id, accessToken: "stub-token" });

    check("本次确实去上游拉了数据", enriched.fetched === true);
    check(`补齐了 ${EPISODES_PER_SUBJECT} 个章节`, enriched.episodes === EPISODES_PER_SUBJECT, enriched.episodes);
    check("同步了 1 条单集进度", enriched.progress === 1, enriched.progress);
    console.log(`     上游请求：条目详情 ${log.subjects} 次 · 章节 ${log.episodes} 次 · 进度 ${log.progress} 次`);
    check("请求数 = 详情 1 + 章节 1 + 进度 1", log.total === 3, log.total);

    const after = await prisma.subject.findUnique({
      where: { id: targetId },
      select: { detailSyncedAt: true, summary: true, _count: { select: { episodes: true } } },
    });
    check("detailSyncedAt 已置位", after?.detailSyncedAt !== null);
    check("简介已升级为完整版", after?.summary?.includes("完整简介") === true, after?.summary);
    check("章节已落库", (after?._count.episodes ?? 0) === EPISODES_PER_SUBJECT);

    // ---------------------------------------------------------------- 缓存命中
    console.log("\n4. 再次打开同一集：走缓存，零请求");
    resetLog();
    const cached = await enrichSubject(targetId, { userId: user.id, accessToken: "stub-token" });
    check("标记为未拉取（缓存命中）", cached.fetched === false);
    check("**零**上游请求", log.total === 0, log.total);

    // ---------------------------------------------------------------- 幂等
    console.log("\n5. 重复导入应幂等");
    resetLog();
    const again = await importUserLibrary(user.id, {
      username: "stub_user",
      accessToken: "stub-token",
    });
    check("条目数不变（无重复插入）", again.subjects === SUBJECT_COUNT, again.subjects);
    check("统计标记为更新而非新建", again.created === 0 && again.updated === SUBJECT_COUNT, again);
    check(
      "重复导入不会把已拉详情的条目降级回轻量态",
      (await prisma.subject.findUnique({ where: { id: targetId }, select: { detailSyncedAt: true } }))?.detailSyncedAt !== null,
    );

    // 只数桩范围内 —— 本地开发库里本来就有真实条目，不能假设全库等于桩数量
    const stubCounts = await prisma.subject.count({
      where: { id: { gte: 800_000, lt: 800_000 + SUBJECT_COUNT } },
    });
    check(`桩条目数 = ${SUBJECT_COUNT}（无重复插入）`, stubCounts === SUBJECT_COUNT, stubCounts);
  } finally {
    globalThis.fetch = REAL_FETCH;
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    // 清理桩数据，避免污染本地库
    await prisma.danmaku.deleteMany({ where: { episode: { subjectId: { gte: 800_000, lt: 900_000 } } } }).catch(() => undefined);
    await prisma.collection.deleteMany({ where: { subjectId: { gte: 800_000, lt: 900_000 } } }).catch(() => undefined);
    await prisma.episodeProgress.deleteMany({ where: { episode: { subjectId: { gte: 800_000, lt: 900_000 } } } }).catch(() => undefined);
    await prisma.episode.deleteMany({ where: { subjectId: { gte: 800_000, lt: 900_000 } } }).catch(() => undefined);
    await prisma.subject.deleteMany({ where: { id: { gte: 800_000, lt: 900_000 } } }).catch(() => undefined);
  }

  console.log(`\n通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("✔ 全部通过（导入只打页数级请求；详情在访问时补齐并缓存）");
  }
}

main()
  .catch((error) => {
    globalThis.fetch = REAL_FETCH;
    console.error("验证异常终止：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
