/**
 * 导入 Animeko 源配置，并逐个验证「搜索」这一步是否真的能取到数据。
 *
 * 为什么必须真跑一遍：转换逻辑正确 ≠ 站点选择器仍然有效。
 * 第三方站改版频繁，写进库里的配置可能早就过期了 ——
 * 逐个试搜才能知道哪些能用，而不是让用户在面对一堆返回空结果的源时莫名其妙。
 *
 * 运行：`npm run sources:import [-- --keyword=魔法少女]`
 */

import { readFile } from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { convertAnimekoExport, type AnimekoSource } from "@/lib/media/animeko-import";
import { createSource, listSources, searchAllSources, updateSource } from "@/lib/media/service";
import { clearResourceCache } from "@/lib/media/resource-service";

const KEYWORD = process.argv.find((arg) => arg.startsWith("--keyword="))?.split("=")[1] ?? "魔法少女";
const FILE =
  process.argv.find((arg) => arg.startsWith("--file="))?.split("=")[1] ??
  process.env.ANIMEKO_SOURCES_FILE ??
  "data/animeko-sources.json";

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(FILE, "utf8");
  } catch {
    /*
     * 源清单是**部署配置**而非代码，因此不在版本库里（见 .gitignore）。
     * 克隆仓库后没有这个文件是正常的 —— 给出可操作的指引，而不是一句 ENOENT。
     */
    console.error(
      `读不到源配置文件：${FILE}\n\n` +
        "这是预期行为 —— 站点清单属于部署方自备，不在版本库中。用法：\n" +
        "  1. 在 Animeko 客户端里导出源配置（设置 → 数据源 → 导出）\n" +
        "  2. 保存为 JSON 后导入：\n" +
        "       npm run sources:import -- --file=你的导出.json\n" +
        "  或者设环境变量 ANIMEKO_SOURCES_FILE 指定路径。\n\n" +
        "字段格式见 examples/animeko-sources.example.json（合成样例，非真实站点）。",
    );
    process.exitCode = 1;
    return;
  }
  const payload = JSON.parse(raw) as { sources: AnimekoSource[] };
  console.log(`读取 ${payload.sources.length} 个源：${FILE}\n`);

  const { converted, failed } = convertAnimekoExport(payload);

  console.log(`=== 转换 ===`);
  console.log(`  ✔ 成功 ${converted.length}`);
  for (const item of converted) {
    const bits = [item.config.searchMode, item.config.videoUrlPattern ? "可提链" : "无提链"];
    console.log(`     ${item.name.padEnd(12)} [${bits.join(" / ")}]`);
  }
  if (failed.length > 0) {
    console.log(`  ✘ 失败 ${failed.length}`);
    for (const item of failed) console.log(`     ${item.name}: ${item.reason}`);
  }

  // ---- 写库（同名则更新，保证重复导入幂等）----
  console.log(`\n=== 写库 ===`);
  const existing = await listSources();
  const byName = new Map(existing.map((s) => [s.name, s]));

  for (const item of converted) {
    const found = byName.get(item.name);
    if (found) {
      await updateSource(found.id, {
        description: item.description,
        config: item.config,
        enabled: true,
      });
      console.log(`  ↻ 更新 ${item.name}`);
    } else {
      await createSource({
        name: item.name,
        description: item.description,
        factory: "web-selector",
        config: item.config,
        // 权重按来源排序：先导入的优先（原 Animeko 的 tier 已丢弃）
        priority: 100 + converted.indexOf(item),
      });
      console.log(`  + 新增 ${item.name}`);
    }
  }

  // ---- 实跑验证 ----
  console.log(`\n=== 试搜验证（关键词「${KEYWORD}」）===`);
  clearResourceCache();

  const sources = await listSources(true);
  const results: { name: string; ok: boolean; hits: number; detail: string }[] = [];

  for (const source of sources) {
    if (source.factory !== "web-selector") continue;
    const t0 = Date.now();
    try {
      const outcome = await probeSourceSearch(source.id, KEYWORD);
      results.push({
        name: source.name,
        ok: outcome.hits > 0,
        hits: outcome.hits,
        detail: outcome.detail,
      });
      const mark = outcome.hits > 0 ? "✔" : "✘";
      console.log(
        `  ${mark} ${source.name.padEnd(12)} 命中 ${String(outcome.hits).padStart(2)} 条 ` +
          `${String(Date.now() - t0).padStart(5)}ms  ${outcome.detail}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: source.name, ok: false, hits: 0, detail: message });
      console.log(`  ✘ ${source.name.padEnd(12)} 失败：${message.slice(0, 70)}`);
    }
  }

  const usable = results.filter((r) => r.ok);
  console.log(`\n=== 结果 ===`);
  console.log(`  可用 ${usable.length} / ${results.length}`);
  if (usable.length > 0) {
    console.log(`  可用源：${usable.map((r) => r.name).join("、")}`);
  }
  const broken = results.filter((r) => !r.ok);
  if (broken.length > 0) {
    console.log(`  不可用：${broken.map((r) => r.name).join("、")}`);
  }
}

/** 只测单个源的搜索步骤（比走完整的资源检索更轻）。 */
async function probeSourceSearch(
  sourceId: string,
  keyword: string,
): Promise<{ hits: number; detail: string }> {
  const [result] = await searchAllSources(keyword, {
    sourceIds: [sourceId],
    maxResultsPerSource: 5,
  });
  if (!result) return { hits: 0, detail: "无返回" };
  if (!result.ok) return { hits: 0, detail: result.error ?? "未知错误" };

  const matched = result.diagnostics?.matchedElements ?? 0;
  const count = result.items.length;
  return {
    hits: count,
    detail:
      count > 0
        ? `首个：${result.items[0].name.slice(0, 40)}`
        : `选择器命中 ${matched} 个元素但未提取出条目`,
  };
}

main()
  .catch((error) => {
    console.error("导入失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
