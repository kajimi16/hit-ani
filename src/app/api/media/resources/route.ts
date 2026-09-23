import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth/session";
import { findSubjectResources, groupByEpisode } from "@/lib/media/resource-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 逐源串行抓取，源多时较慢；结果有 10 分钟缓存，通常只有首次慢。 */
export const maxDuration = 120;

/**
 * GET /api/media/resources?subjectId=&refresh=
 *
 * 返回该条目的外部资源索引（来自已配置的抓取源）。
 *
 * ⚠️ 返回的是**外站链接**，由用户浏览器直接打开，本平台不代理视频字节。
 */
export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const subjectId = Number(params.get("subjectId"));
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    return NextResponse.json({ error: "subjectId 不合法" }, { status: 400 });
  }

  try {
    const result = await findSubjectResources(subjectId, {
      forceRefresh: params.get("refresh") === "1",
    });

    return NextResponse.json({
      ...result,
      // 预先按集号分组，省得前端再算一遍（分组规则是业务语义，应留在服务端）
      groups: groupByEpisode(result.resources),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
