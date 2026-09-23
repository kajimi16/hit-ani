/**
 * BGM 导入任务的状态机单测 —— 用真实数据库，桩掉上游 API。
 *
 * 覆盖两个真实 bug：
 *
 *  1. **外键顺序**：`Collection.subjectId` 指向 `Subject`。启动任务时若先写收藏关系，
 *     会撞 `Collection_subjectId_fkey`，整次导入在第一秒就 502。
 *     正确顺序是「快照 → 逐条导入 Subject → 再写 Collection」。
 *
 *  2. **完成后的幂等**：任务 `done` 之后，任何多余的 POST 都不得重新抓快照、
 *     把 `cursor` 清零。真实事故里正是这一点让一个跑完的 377 条任务被打回 180。
 *
 * 运行：`npm run import-check`（需要可写的 DATABASE_URL）
 */

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";
import {
  BATCH_SIZE,
  getImportJob,
  runImportTick,
  startImportJob,
} from "@/lib/bgm/import";

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

/** 桩：返回 `count` 条收藏，每个条目有 2 集、1 条进度。 */
function stubUpstream(count: number): void {
  const subjectIds = Array.from({ length: count }, (_, i) => 900_000 + i);

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });

    if (url.includes("/collections?")) {
      const parsed = new URL(url);
      const offset = Number(parsed.searchParams.get("offset") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 100);
      const slice = subjectIds.slice(offset, offset + limit);
      return json({
        total: subjectIds.length,
        limit,
        offset,
        data: slice.map((id, i) => ({
          subject_id: id,
          subject_type: 2,
          rate: (offset + i) % 11,
          type: ((offset + i) % 3) + 1,
          comment: `note-${id}`,
          tags: [],
          ep_status: 0,
          vol_status: 0,
          updated_at: new Date().toISOString(),
          private: false,
        })),
      });
    }

    const subjectMatch = /\/v0\/subjects\/(\d+)/.exec(url);
    if (subjectMatch) {
      const id = Number(subjectMatch[1]);
      return json({
        id,
        type: 2,
        name: `Stub ${id}`,
        name_cn: `桩条目 ${id}`,
        summary: "stub",
        series: false,
        nsfw: false,
        locked: false,
        date: "2020-01-01",
        platform: "",
        images: { large: "https://lain.bgm.tv/x.jpg", common: "https://lain.bgm.tv/x.jpg" },
        volumes: 0,
        eps: 2,
        total_episodes: 2,
        rating: { rank: 1, total: 1, count: {}, score: 7 },
      });
    }

    if (url.includes("/v0/episodes?")) {
      const parsed = new URL(url);
      const subjectId = Number(parsed.searchParams.get("subject_id"));
      return json({
        total: 2,
        limit: 100,
        offset: 0,
        data: [1, 2].map((n) => ({
          id: subjectId * 10 + n,
          type: 0,
          name: `EP${n}`,
          name_cn: `第 ${n} 话`,
          sort: n,
          ep: n,
          airdate: "2020-01-01",
          comment: 0,
          duration: "24m",
          desc: "",
          disc: 0,
        })),
      });
    }

    if (url.includes("/collections/") && url.includes("/episodes")) {
      const parsed = new URL(url);
      const subjectId = Number(/\/collections\/(\d+)\/episodes/.exec(parsed.pathname)?.[1]);
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
  console.log("=== BGM 导入任务状态机验证（上游打桩）===\n");

  const user = await prisma.user.create({
    data: {
      email: `importcheck-${Date.now()}@hit.edu.cn`,
      nickname: "导入验证",
      passwordHash: await hashPassword("importcheck-password"),
      schoolId: "hit",
    },
    select: { id: true },
  });

  const TOTAL = BATCH_SIZE + 3; // 覆盖「刚好一批」与「多出几条」

  try {
    stubUpstream(TOTAL);

    // ------------------------------------------------------------ 快照
    console.log("1. 启动任务：抓快照");
    const started = await startImportJob(user.id, {
      username: "stub_user",
      accessToken: "stub-token",
    });
    check("状态为 running", started.status === "running", started.status);
    check("总数等于上游收藏数", started.total === TOTAL, started.total);
    check("游标归零", started.processed === 0, started.processed);

    // ★ 这一条正是外键 bug：启动阶段不得写 Collection（Subject 还不存在）
    check(
      "启动阶段未写 Collection（避免外键约束失败）",
      (await prisma.collection.count({ where: { userId: user.id } })) === 0,
    );

    // ------------------------------------------------------------ 第一批
    console.log("\n2. 推进第一批");
    const first = await runImportTick(user.id, "stub-token");
    check(
      "游标推进一批",
      first.processed === Math.min(BATCH_SIZE, TOTAL),
      first.processed,
    );
    check("状态仍为 running", first.status === "running", first.status);
    check("无失败", first.failureCount === 0, first.failures);
    check(
      "第一批已写入 Collection（此时 Subject 已存在）",
      (await prisma.collection.count({ where: { userId: user.id } })) === BATCH_SIZE,
    );
    check(
      "Collection 关联的 Subject 均存在（外键成立）",
      (await prisma.collection.count({
        where: { userId: user.id, subject: { is: {} } },
      })) === BATCH_SIZE,
    );
    check("章节已落库", first.stats.episodes === BATCH_SIZE * 2, first.stats.episodes);
    check("进度已落库", first.stats.progress === BATCH_SIZE, first.stats.progress);

    // ------------------------------------------------------------ 收尾
    console.log("\n3. 推进至完成");
    let view = first;
    while (view.status === "running") {
      view = await runImportTick(user.id, "stub-token");
    }
    check("最终状态为 done", view.status === "done", view.status);
    check("游标等于总数", view.processed === TOTAL, view.processed);
    check("条目数等于总数", view.stats.subjects === TOTAL, view.stats.subjects);
    check("失败数为 0", view.failureCount === 0, view.failures);

    const binding = await prisma.bgmBinding.findFirst({ where: { userId: user.id } });
    // 未建立 BgmBinding，同步时间更新会抛错 —— 因此这里只断言任务本身
    void binding;

    // ------------------------------------------------------------ 幂等
    console.log("\n4. 完成后重复 POST 不得重跑（真实事故点）");
    const afterDone = await getImportJob(user.id);
    check("再次读取仍是 done", afterDone?.status === "done", afterDone?.status);
    check("游标未被清零", afterDone?.processed === TOTAL, afterDone?.processed);
    check(
      "统计未被重置",
      afterDone?.stats.subjects === TOTAL,
      afterDone?.stats.subjects,
    );

    // 直接调 runImportTick 也应当是 no-op
    const tickAfterDone = await runImportTick(user.id, "stub-token");
    check(
      "对已完成任务调用 tick 不改变状态",
      tickAfterDone.status === "done" && tickAfterDone.processed === TOTAL,
      { status: tickAfterDone.status, processed: tickAfterDone.processed },
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log(`\n通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("✔ 全部通过（快照顺序正确、分批推进、完成后幂等）");
  }
}

main()
  .catch((error) => {
    globalThis.fetch = REAL_FETCH;
    console.error("验证异常终止：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
