import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { z } from "zod";
import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { requireSessionUser } from "@/lib/auth/session";
import { EpisodeCollectionType, getEpisode, putEpisodeCollection } from "@/lib/bgm/client";
import { decideMirror, logMirrorWrite, type MirrorSkipCode } from "@/lib/bgm/mirror-guard";
import { hostHeadersFrom, resolvePublicOrigin } from "@/lib/auth/request-origin";
import { CollectionStatus } from "@/lib/collection";
import { clampPlayTime } from "@/lib/danmaku/window";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  episodeId: z.number().int().positive(),
  /**
   * 0未看 1想看 2看过 3抛弃 —— 对齐 BGM `EpisodeCollectionType`。
   *
   * **可选**：只上报播放位置时不传它。位置与观看状态是两件正交的事 ——
   * 让「上报看到第几秒」顺带把该集标成「想看」是明显的错误。
   */
  type: z
    .union([
      z.literal(EpisodeCollectionType.None),
      z.literal(EpisodeCollectionType.Wish),
      z.literal(EpisodeCollectionType.Done),
      z.literal(EpisodeCollectionType.Dropped),
    ])
    .optional(),
  /**
   * 当前播放位置（毫秒）。**可选** —— 标记观/未观时不必传。
   *
   * 与 `type` 走同一个接口而不是单开一个：播放器在播放时本来就要周期性
   * 上报，多一个端点只是多一条要维护的路径。
   *
   * 只接受 0 以上的整数，上界在服务端钳制（见下方 `clampPlayTime`）——
   * 客户端上报的位置**不可信**：程序化赋值 `video.currentTime` 能绕过
   * 客户端的一切限制。
   */
  playbackPositionMs: z.number().int().min(0).optional(),
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

  /*
   * 观看状态：只在调用方**明确给了 type** 时更新。
   *
   * 位置上报（播放器周期性触发）不带 type，因此不会动这一行。
   */
  const progress =
    body.type === undefined
      ? await prisma.episodeProgress.findUnique({
          where: { userId_episodeId: { userId: user.id, episodeId: body.episodeId } },
        })
      : await prisma.episodeProgress.upsert({
          where: { userId_episodeId: { userId: user.id, episodeId: body.episodeId } },
          create: { userId: user.id, episodeId: body.episodeId, type: body.type },
          update: { type: body.type },
        });

  /*
   * 续播位置。
   *
   * 写到**条目级**的 `Collection.playbackPositionMs`（不是本集的进度行）——
   * 一部番同一时刻只会在一个位置继续看，换集时覆盖即可。
   *
   * 服务端**独立钳制**客户端上报的值：客户端可被篡改，且程序化赋值
   * `video.currentTime` 能绕过客户端的一切限制。上界复用与弹幕窗口同一个
   * 常量（24 小时）—— 超过它的一定不是真实播放位置。
   */
  if (body.playbackPositionMs !== undefined) {
    const position = clampPlayTime(body.playbackPositionMs);
    await prisma.collection.upsert({
      where: { userId_subjectId: { userId: user.id, subjectId: episode.subjectId } },
      create: {
        userId: user.id,
        subjectId: episode.subjectId,
        // 还没收藏就顺手建一条「在看」—— 正在看却不在追番列表里是矛盾的
        type: CollectionStatus.Doing,
        playbackPositionMs: position,
        // 位置必须连带记下「属于哪一集」，否则换集后会拿上一集的位置续播
        playbackEpisodeId: body.episodeId,
        source: "local",
      },
      /*
       * 两个字段必须**成对**更新：只更新位置而不更新集号，会让新集的位置
       * 配上旧的集号，续播判断随即失效（看起来像「续播突然不灵了」）。
       */
      update: { playbackPositionMs: position, playbackEpisodeId: body.episodeId },
    });
  }

  // `null` = 未绑定，没有可同步的目标；`true/false` = 已绑定且同步成功/失败。
  // 与 `collection-actions.ts` 的 setCollectionStatus 保持同一语义 ——
  // 用 false 表示「未绑定」会被误读为「同步失败」。
  let bgmSynced: boolean | null = null;
  let bgmError: string | null = null;
  /** 未镜像的原因码 —— 界面据此区分「未开启」与「真失败」。 */
  let bgmSkip: MirrorSkipCode | null = null;
  /*
   * 与 `collection-actions` 同一道闸门 —— 进度同样会镜像到上游，
   * 也不能被测试账号触发（见 mirror-guard.ts 记录的真实事故）。
   */
  const mirror = decideMirror({ email: user.email, mirrorToBgm: user.mirrorToBgm });
  /*
   * 只有「改观看状态」才镜像到上游。纯位置上报（不带 type）不镜像 ——
   * Bangumi 的 episode collection 接口没有「播放位置」这个概念。
   */
  if (body.type === undefined) {
    // 跳过整个镜像分支
  } else if (user.bgmBound && !mirror.allowed) {
    /*
     * `bgmSynced = false` 而不是留 null —— 与 `collection-actions` 保持一致。
     *
     * 三态的语义：`null` = 未绑定（没有可同步的目标）、`false` = 绑定了但没同步成功、
     * `true` = 同步成功。若这里留 null，界面就得靠 `!bgmSynced` 这种真假判断，
     * 而哪天有人改成 `=== false` 就会**静默失效**（提示不再出现）。
     */
    bgmSynced = false;
    bgmError = mirror.reason;
    bgmSkip = mirror.code;
    console.warn(`[bgm-mirror] 已阻止进度写入：${mirror.reason}`);
  } else if (user.bgmBound) {
    try {
      const { accessToken } = await getFreshBgmAccessToken(
        user.id,
        resolvePublicOrigin(hostHeadersFrom(await headers()), new URL(request.url).origin).origin,
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
      logMirrorWrite({
        userId: user.id,
        email: user.email,
        target: "episode-progress",
        episodeId: episode.id,
        fields: { type: body.type },
      });
      bgmSynced = true;
    } catch (error) {
      bgmError = error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json({
    /*
     * 纯位置上报时可能本来就没有这一行（用户还没标记过该集），
     * 因此不能假定它存在。
     */
    progress: progress ? { episodeId: progress.episodeId, type: progress.type } : null,
    bgmBound: user.bgmBound,
    bgmSynced,
    bgmError,
    bgmSkip,
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
