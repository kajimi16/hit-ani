import { NextResponse } from "next/server";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/search?keyword=&type=2&tags=a,b&minScore=&maxScore=&sort=
 *
 * 直通 BGM `POST /v0/search/subjects`（已实测可用，无需授权）。
 * 不落库：搜索是探索路径，命中详情后才缓存。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const keyword = (url.searchParams.get("keyword") ?? "").trim();

  if (!keyword) {
    return NextResponse.json({ error: "缺少 keyword" }, { status: 400 });
  }

  const typeParam = url.searchParams.get("type");
  const type = typeParam ? Number(typeParam) : SubjectType.Anime;
  if (![1, 2, 3, 4, 6].includes(type)) {
    return NextResponse.json({ error: "type 不合法" }, { status: 400 });
  }

  const tags = url.searchParams
    .get("tags")
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const minScore = url.searchParams.get("minScore");
  const maxScore = url.searchParams.get("maxScore");
  const rating: string[] = [];
  if (minScore) rating.push(`>=${minScore}`);
  if (maxScore) rating.push(`<${maxScore}`);

  const sortParam = url.searchParams.get("sort") ?? "match";
  const sort = (["match", "heat", "rank", "score"].includes(sortParam)
    ? sortParam
    : "match") as "match" | "heat" | "rank" | "score";

  const limit = clamp(Number(url.searchParams.get("limit") ?? 20), 1, 50);
  const offset = clamp(Number(url.searchParams.get("offset") ?? 0), 0, 10000);

  try {
    const page = await searchSubjects(
      {
        keyword,
        sort,
        filter: {
          type: [type] as never,
          ...(tags && tags.length > 0 ? { tag: tags } : {}),
          ...(rating.length > 0 ? { rating } : {}),
          nsfw: false,
        },
      },
      { limit, offset },
    );

    return NextResponse.json({
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      data: page.data.map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        nameCn: item.name_cn,
        summary: item.summary,
        coverUrl: item.images?.large ?? item.images?.common ?? null,
        airDate: item.date ?? null,
        score: item.rating?.score ?? null,
        rank: item.rating?.rank ?? null,
        tags: item.tags ?? [],
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Bangumi 搜索失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
