import { NextResponse } from "next/server";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";
import { isoDate, weekRange } from "@/lib/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/schedule?weekOffset=0
 *
 * Bangumi `v0` 没有时间表端点（`open-api/v0.yaml` 的 tags 仅
 * 条目/章节/角色/人物/用户/收藏/编辑历史/目录），因此按 `air_date` 区间检索聚合。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("weekOffset") ?? 0);
  const weekOffset = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), -8), 8) : 0;

  const { start, end } = weekRange(new Date(), weekOffset);

  try {
    const page = await searchSubjects(
      {
        keyword: "",
        sort: "heat",
        filter: {
          type: [SubjectType.Anime] as never,
          air_date: [`>=${isoDate(start)}`, `<=${isoDate(end)}`],
          nsfw: false,
        },
      },
      { limit: 50 },
    );

    const byDate = new Map<string, typeof page.data>();
    for (const subject of page.data) {
      if (!subject.date) continue;
      const list = byDate.get(subject.date) ?? [];
      list.push(subject);
      byDate.set(subject.date, list);
    }

    const days = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, items]) => ({
        date,
        items: items
          .sort((a, b) => (b.rating?.total ?? 0) - (a.rating?.total ?? 0))
          .map((subject) => ({
            id: subject.id,
            name: subject.name,
            nameCn: subject.name_cn,
            coverUrl: subject.images?.common ?? null,
            score: subject.rating?.score ?? null,
            collectionTotal: subject.rating?.total ?? 0,
            tags: subject.tags ?? [],
          })),
      }));

    return NextResponse.json({
      weekStart: isoDate(start),
      weekEnd: isoDate(end),
      weekOffset,
      total: page.total,
      days,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "获取时间表失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
