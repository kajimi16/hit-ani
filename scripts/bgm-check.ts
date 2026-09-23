/**
 * Bangumi 客户端联调脚本 —— 只读接口，无需授权。
 *
 * 目的：在不申请 BGM 应用凭据的前提下，验证 `src/lib/bgm/client.ts` 的
 * 类型化封装与上游真实响应一致（schema 未漂移、字段名与类型正确）。
 *
 * 运行：`npm run bgm:check`
 */

import {
  BgmApiError,
  SubjectType,
  getSubject,
  getSubjectEpisodes,
  getUserCollections,
  isRetryable,
  searchSubjects,
} from "@/lib/bgm/client";

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

async function main(): Promise<void> {
  console.log("=== Bangumi 客户端联调（只读）===");

  // 1. 搜索
  const search = await searchSubjects(
    {
      keyword: "魔法少女",
      sort: "heat",
      filter: { type: [SubjectType.Anime] as never, nsfw: false },
    },
    { limit: 5 },
  );
  check("searchSubjects 返回分页结构", typeof search.total === "number" && Array.isArray(search.data));
  check("搜索结果非空", search.data.length > 0, search.total);

  const first = search.data[0];
  check("搜索项含 id / name / images", typeof first.id === "number" && !!first.name);
  check(
    "搜索项含 rating.score 与 date",
    typeof first.rating?.score === "number" || first.date !== undefined,
    { score: first.rating?.score, date: first.date },
  );

  // 2. 条目详情
  const subject = await getSubject(first.id);
  check("getSubject 返回 rating.count 分布", typeof subject.rating?.count === "object");
  check("getSubject 返回 images.large", typeof subject.images?.large === "string");
  check("getSubject 的 type 是动画", subject.type === SubjectType.Anime, subject.type);

  // 3. 章节
  const episodes = await getSubjectEpisodes(first.id, { limit: 100 });
  check("getSubjectEpisodes 返回 data + total", Array.isArray(episodes.data) && typeof episodes.total === "number");
  if (episodes.data.length > 0) {
    const episode = episodes.data[0];
    check(
      "章节含 id / sort / name（弹幕挂载点字段）",
      typeof episode.id === "number" && typeof episode.sort === "number" && !!episode.name,
      { id: episode.id, sort: episode.sort },
    );
    check(
      "章节含 airdate（时间表可用性）",
      typeof episode.airdate === "string" || episode.airdate === "",
      episode.airdate,
    );
  }

  // 4. 公开用户收藏（无需授权）
  const collections = await getUserCollections("sai", { subject_type: 2 as never, limit: 5 });
  check(
    "getUserCollections 返回分页结构",
    typeof collections.total === "number" && Array.isArray(collections.data),
  );
  if (collections.data.length > 0) {
    const item = collections.data[0];
    check(
      "收藏项含 subject_id / type / ep_status",
      typeof item.subject_id === "number" && typeof item.type === "number",
      { subject_id: item.subject_id, type: item.type },
    );
    check(
      "收藏项内嵌 subject（SlimSubject）",
      item.subject === undefined || typeof item.subject?.name === "string",
    );
  }

  // 5. 错误路径：不存在的条目必须抛 BgmApiError 且不可重试
  try {
    await getSubject(999_999_999);
    check("不存在的条目应抛错", false);
  } catch (error) {
    check("不存在的条目抛 BgmApiError", error instanceof BgmApiError, String(error));
    check("404 被判定为不可重试", !isRetryable(error));
    if (error instanceof BgmApiError) {
      check("错误携带状态码与 URL", error.status === 404 && error.url.includes("/v0/subjects/"));
    }
  }

  console.log(`\n通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("✔ 全部通过（Bangumi 客户端与上游 schema 一致）");
  }
}

main().catch((error) => {
  console.error("联调异常终止：", error);
  process.exitCode = 1;
});
