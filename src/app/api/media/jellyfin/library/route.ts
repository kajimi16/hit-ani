import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import {
  listPlayableEpisodes,
  matchSubjectOnConnections,
} from "@/lib/media/jellyfin-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * BGM 条目 → Jellyfin 媒体库的匹配与剧集列表。
 *
 * - `GET ?subjectId=` 匹配各连接上的系列
 * - `GET ?connectionId=&seriesId=` 列出该系列的剧集与直连播放地址
 *
 * ⚠️ 返回的 `streamUrl` 含用户自己的 Jellyfin token，且指向 Jellyfin 服务器本身 ——
 * 视频字节由浏览器直连，**不经过本服务**。
 */

const querySchema = z.union([
  z.object({ subjectId: z.coerce.number().int().positive() }),
  z.object({
    connectionId: z.string().min(1).max(64),
    seriesId: z.string().min(1).max(64),
  }),
]);

export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const params = new URL(request.url).searchParams;

  let query;
  try {
    query =
      params.get("subjectId") !== null
        ? querySchema.parse({ subjectId: params.get("subjectId") })
        : querySchema.parse({
            connectionId: params.get("connectionId"),
            seriesId: params.get("seriesId"),
          });
  } catch (error) {
    return NextResponse.json(
      {
        error: "参数不合法：需要 subjectId，或 connectionId + seriesId",
        details: error instanceof z.ZodError ? error.issues : String(error),
      },
      { status: 400 },
    );
  }

  if ("subjectId" in query) {
    const subject = await prisma.subject.findUnique({
      where: { id: query.subjectId },
      select: { name: true, nameCn: true },
    });
    if (!subject) {
      return NextResponse.json(
        { error: "条目尚未缓存到本地，请先打开条目详情页" },
        { status: 404 },
      );
    }

    const matches = await matchSubjectOnConnections(user.id, {
      name: subject.name,
      nameCn: subject.nameCn,
    });
    return NextResponse.json({ subject: { name: subject.name, nameCn: subject.nameCn }, matches });
  }

  try {
    const episodes = await listPlayableEpisodes(user.id, query.connectionId, query.seriesId);
    return NextResponse.json({
      connectionId: query.connectionId,
      seriesId: query.seriesId,
      episodes,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
