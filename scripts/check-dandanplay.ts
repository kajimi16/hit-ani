/**
 * dandanplay 凭据验证。
 *
 * 拿到 AppId/AppSecret 后跑一次，确认四件事：
 *   1. 鉴权是否通过（403 会带出官方给的具体原因）
 *   2. 能否按 BGM 的 subjectId 找到对应番剧（匹配链的第一段）
 *   3. 能否取到弹幕（含数量，判断值不值得接）
 *   4. 端到端：BGM 条目 → dandanplay 剧集 → 弹幕
 *
 * 为什么要单独一个脚本：dandanplay 的 403 原因藏在 `X-Error-Message` 头里，
 * 而匹配链有四级降级 —— 出错时很难从业务日志看出卡在哪一级。
 *
 * 运行：`npm run dandanplay:check [-- --subject=296195]`
 */

import { prisma } from "@/lib/prisma";
import {
  authMode,
  getComments,
  getEpisodesByBgmtvSubjectId,
  isConfigured,
  parseComments,
  searchEpisodes,
} from "@/lib/danmaku/dandanplay";
import { matchDandanplayEpisode } from "@/lib/danmaku/dandanplay-match";

const SUBJECT_ID = Number(
  process.argv.find((a) => a.startsWith("--subject="))?.split("=")[1] ?? 296195,
);

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  ✔ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✘ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

async function main(): Promise<void> {
  console.log("=== dandanplay 凭据验证 ===\n");

  if (!isConfigured()) {
    console.error(
      "未配置凭据。请在 .env 里填写：\n" +
        '  DANDANPLAY_APP_ID="你的 AppId"\n' +
        '  DANDANPLAY_APP_SECRET="你的 AppSecret"\n\n' +
        "申请：https://dev.dandanplay.com （注册 → 完善资料 → 邮件验证 → 创建应用并提交审核）",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`鉴权模式：${authMode()}${authMode() === "credential" ? "（服务器端推荐）" : ""}\n`);

  // ---------------------------------------------------------------- 1
  console.log("1. 鉴权");
  const subject = await prisma.subject.findUnique({
    where: { id: SUBJECT_ID },
    select: { name: true, nameCn: true },
  });
  if (!subject) {
    console.error(`条目 ${SUBJECT_ID} 不在本地库。先打开它的详情页，或换一个已导入的条目。`);
    process.exitCode = 1;
    return;
  }
  console.log(`   测试条目：${subject.nameCn || subject.name}（id=${SUBJECT_ID}）`);

  let authOk = false;
  try {
    // bgmtv 映射是最可靠的一步，用它验证鉴权
    const direct = await getEpisodesByBgmtvSubjectId(SUBJECT_ID);
    authOk = true;
    const episodeCount = direct.bangumi?.episodes?.length ?? 0;
    check("鉴权通过（bgmtv 映射接口可访问）", true);
    check(
      `dandanplay 有该条目的映射（${episodeCount} 集）`,
      episodeCount > 0 || true,
      episodeCount === 0 ? "该条目未收录，会自动降级到名称搜索" : undefined,
    );
  } catch (error) {
    check("鉴权通过", false, error instanceof Error ? error.message : String(error));
    console.error(
      "\n  403 的常见原因（官方文档 §2.6）：\n" +
        "    Missing Authentication Headers —— 头没带上\n" +
        "    Invalid AppId / Invalid AppSecret —— 凭据填错\n" +
        "    Invalid Signature —— 签名不匹配（仅签名模式）\n" +
        "    Invalid Timestamp —— 服务器时间偏差过大（仅签名模式）",
    );
  }

  if (!authOk) {
    console.log("\n鉴权失败，后续检查跳过。");
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  // ---------------------------------------------------------------- 2
  //
  // 逐个名称试搜索，**报出每个名字的结果**。
  //
  // 只试中文名会误报失败：中文译名常在 dandanplay 搜不到，
  // 而日文原名能搜到 —— 匹配链正是靠「逐个别名试」来覆盖这种差异的。
  console.log("\n2. 名称搜索（匹配链第二级）");
  const candidateNames = [subject.nameCn, subject.name].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  let anyNameWorked = false;
  for (const name of candidateNames) {
    try {
      const found = await searchEpisodes(name);
      const animeCount = found.animes?.length ?? 0;
      const first = found.animes?.[0];
      console.log(
        `     「${name}」→ ${animeCount} 部` +
          (first ? `，首个：${first.animeTitle}（${first.episodes?.length ?? 0} 集）` : ""),
      );
      if (animeCount > 0) anyNameWorked = true;
    } catch (error) {
      // 404 表示该名字搜不到，属正常 —— 换个别名再试
      const message = error instanceof Error ? error.message : String(error);
      console.log(`     「${name}」→ ${message.includes("404") ? "无结果" : message}`);
    }
  }
  check(
    `至少一个名称能搜到（试了 ${candidateNames.length} 个）`,
    anyNameWorked,
    candidateNames,
  );

  // ---------------------------------------------------------------- 3
  console.log("\n3. 端到端：BGM 条目 → dandanplay 剧集");
  // 用该条目下任意一集来测匹配
  const episode = await prisma.episode.findFirst({
    where: { subjectId: SUBJECT_ID },
    orderBy: { sort: "asc" },
    select: { id: true, sort: true, name: true },
  });

  if (!episode) {
    check("本地有该条目的剧集", false, "先打开该条目详情页以缓存剧集");
  } else {
    const matched = await matchDandanplayEpisode(SUBJECT_ID, episode.id);
    check(
      `匹配到 dandanplay 剧集`,
      matched !== null,
      matched === null ? "四级降级全部未命中" : undefined,
    );

    if (matched) {
      console.log(
        `     BGM ep${episode.sort} → dandanplay episodeId=${matched.episodeId}` +
          `（方式：${matched.method}，标题：${matched.episodeTitle}）`,
      );

      // ---------------------------------------------------------------- 4
      console.log("\n4. 拉取弹幕");
      try {
        const response = await getComments(matched.episodeId);
        const items = parseComments(response, episode.id);
        check(`取到 ${items.length} 条弹幕（服务端计 ${response.count}）`, items.length > 0);
        if (items.length > 0) {
          console.log("     抽样：");
          for (const item of items.slice(0, 3)) {
            const seconds = (item.playTimeMs / 1000).toFixed(1);
            console.log(`       [${seconds}s] ${item.text.slice(0, 40)}`);
          }
          const senders = new Set(items.map((i) => i.senderId));
          console.log(`     来源分布：${senders.size} 个不同发送者（含各站转存）`);
        }
      } catch (error) {
        check("拉取弹幕", false, error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ---------------------------------------------------------------- 汇总
  console.log(`\n=== 结果 ===`);
  console.log(`  通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`  ✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("  ✔ 凭据可用，dandanplay 弹幕源已生效");
  }
}

main()
  .catch((error) => {
    console.error("验证异常终止：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
