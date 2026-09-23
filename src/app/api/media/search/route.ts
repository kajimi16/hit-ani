import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { searchAllSources } from "@/lib/media/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 逐个源串行抓取，多个源时可能较慢。 */
export const maxDuration = 120;

const schema = z.object({
  keyword: z.string().min(1).max(128),
  sourceIds: z.array(z.string().max(64)).max(20).optional(),
  maxResultsPerSource: z.number().int().min(1).max(50).optional(),
});

/**
 * POST /api/media/search — 用已配置的源搜索资源。
 *
 * 单源失败不影响其它源（返回里带 `ok: false` 与 `error`），
 * 界面可以逐源展示状态 —— 第三方源必然会有挂掉的时候。
 */
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

  const results = await searchAllSources(body.keyword, {
    sourceIds: body.sourceIds,
    maxResultsPerSource: body.maxResultsPerSource,
  });

  return NextResponse.json({
    keyword: body.keyword,
    total: results.reduce(
      (sum, result) => sum + result.items.length + result.feedItems.length,
      0,
    ),
    /** 成功返回的源数量，便于界面提示「3/5 个源有响应」 */
    okCount: results.filter((result) => result.ok).length,
    sourceCount: results.length,
    results,
  });
}
