import { NextResponse } from "next/server";
import { z } from "zod";
import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { requireSessionUser } from "@/lib/auth/session";
import { EpisodeCollectionType, getEpisode, putEpisodeCollection } from "@/lib/bgm/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  episodeId: z.number().int().positive(),
  /** 0未看 1想看 2看过 3抛弃 —— 对齐 BGM `EpisodeCollectionType`。 */
  type: z.union([
    z.literal(EpisodeCollectionType.None),
    z.literal(EpisodeCollectionType.Wish),
    z.literal(EpisodeCollectionType.Done),
    z.literal(EpisodeCollectionType.Dropped),
  ]),
});

/**
 * PUT /api/progress
 *
 * 单集观看进度：本地 `EpisodeProgress` 为权威来源（离线也能改），
 * 已绑定 BGM 时再镜像写回 —— 写回失败不阻断本地记录，只在响应里标记 `bgmSynced: false`。
 *
 * BGM 侧要求该条目已被收藏，否则返回 400；此处按降级处理而非报错。
 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = updateSchema.parse(await request.json());
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

  const episode = await prisma.episode.findUnique({
    where: { id: body.episodeId },
    select: { id: true, subjectId: true },
  });
  if (!episode) {
    return NextResponse.json({ error: "章节不存在" }, { status: 404 });
  }

  const progress = await prisma.episodeProgress.upsert({
    where: { userId_episodeId: { userId: user.id, episodeId: body.episodeId } },
    create: { userId: user.id, episodeId: body.episodeId, type: body.type },
    update: { type: body.type },
  });

  // `null` = 未绑定，没有可同步的目标；`true/false` = 已绑定且同步成功/失败。
  // 与 `collection-actions.ts` 的 setCollectionStatus 保持同一语义 ——
  // 用 false 表示「未绑定」会被误读为「同步失败」。
  let bgmSynced: boolean | null = null;
  let bgmError: string | null = null;
  if (user.bgmBound) {
    try {
      const { accessToken } = await getFreshBgmAccessToken(
        user.id,
        new URL(request.url).origin,
      );

      // 写之前先核对「这个 episode 在上游确实属于这个条目」。
      //
      // 为什么必须查：BGM 的 episode id 是**全局**的，一旦本地 `Episode.subjectId`
      // 与上游不一致（例如手写的种子数据把 episode 8 挂到了 subject 8，
      // 而上游 episode 8 实际属于 subject 15），这条 PUT 会把观看进度写到
      // **另一个条目的某一集**上 —— 静默的数据损坏，用户事后无从察觉。
      //
      // 代价是每次进度写入多一次 GET；相比写错数据，这个代价可以接受。
      const upstream = await getEpisode(episode.id, { accessToken });
      if (upstream.id !== episode.id || upstream.subject_id !== episode.subjectId) {
        throw new Error(
          `本地剧集映射与 Bangumi 不一致（本地 episode ${episode.id} → subject ` +
            `${episode.subjectId}，上游 → subject ${upstream.subject_id}），` +
            `已阻止写入以避免污染错误的剧集`,
        );
      }

      await putEpisodeCollection(episode.id, body.type, { accessToken });
      bgmSynced = true;
    } catch (error) {
      bgmError = error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json({
    progress: { episodeId: progress.episodeId, type: progress.type },
    bgmBound: user.bgmBound,
    bgmSynced,
    bgmError,
  });
}

const querySchema = z.object({
  subjectId: z.coerce.number().int().positive(),
});

/** GET /api/progress?subjectId= — 当前用户在该条目下的全部单集进度。 */
export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ entries: {} });

  const url = new URL(request.url);
  let query;
  try {
    query = querySchema.parse({ subjectId: url.searchParams.get("subjectId") });
  } catch (error) {
    return NextResponse.json(
      { error: "参数不合法", details: error instanceof z.ZodError ? error.issues : String(error) },
      { status: 400 },
    );
  }

  const rows = await prisma.episodeProgress.findMany({
    where: { userId: user.id, episode: { subjectId: query.subjectId } },
    select: { episodeId: true, type: true },
  });

  const entries: Record<number, number> = {};
  for (const row of rows) entries[row.episodeId] = row.type;

  return NextResponse.json({ entries });
}
