import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { fetchEpisodesFor, resolveVideoFor } from "@/lib/media/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 解析要串行访问详情页 + 播放页，放宽时限。 */
export const maxDuration = 60;

/**
 * 站内播放的资源解析。
 *
 * - `action=episodes`：从条目详情页取剧集列表
 * - `action=resolve`：从播放页解析视频直链
 *
 * ⚠️ API 边界：本接口只抓取**网页 HTML**（索引行为），
 * 返回的视频 URL 交给浏览器 `<video>` 直接拉流 ——
 * 视频字节**不经过本服务**，因此不产生带宽成本（见 docs/MEDIA.md §6.4）。
 */

const schema = z.object({
  action: z.enum(["episodes", "resolve"]),
  sourceId: z.string().min(1).max(64),
  /** episodes 用条目页 URL；resolve 用剧集播放页 URL */
  url: z.string().url().max(2048),
});

export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = schema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error: "参数不合法",
        details:
          error instanceof z.ZodError
            ? error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
              }))
            : String(error),
      },
      { status: 400 },
    );
  }

  try {
    if (body.action === "episodes") {
      const result = await fetchEpisodesFor(body.sourceId, body.url);
      return NextResponse.json(result, { status: result.ok ? 200 : 502 });
    }

    const result = await resolveVideoFor(body.sourceId, body.url);
    return NextResponse.json(result, { status: result.ok ? 200 : 502 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
