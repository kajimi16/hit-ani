import { headers } from "next/headers";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import EpisodeWorkspace, { type EpisodeItem } from "@/components/episode-workspace";
import { IconStar } from "@/components/icons";
import CollectionPicker from "@/components/collection-picker";
import ExternalResources from "@/components/external-resources";
import JellyfinPanel from "@/components/jellyfin-panel";
import type { CollectionStatusValue } from "@/lib/collection";
import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { countByEpisodeIds } from "@/lib/danmaku/repository";
import { listSources } from "@/lib/media/service";
import { prisma } from "@/lib/prisma";
import { enrichSubject } from "@/lib/bgm/import";

export const dynamic = "force-dynamic";

/**
 * 条目详情：本地缓存优先，未缓存时回源 BGM 并落库。
 * 落库是必需的 —— `Episode` 行是弹幕的外键挂载点。
 */
export default async function SubjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const subjectId = Number(id);
  if (!Number.isInteger(subjectId) || subjectId <= 0) notFound();

  const user = await getSessionUser();

  let subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    include: { episodes: { orderBy: { sort: "asc" } } },
  });

  // 访问时补齐：本地只有轻量数据（`detailSyncedAt` 为 null）或没有章节时，
  // 去上游拉详情 + 章节并缓存。已完整的条目直接走本地，不发请求。
  const needsEnrich =
    !subject || subject.detailSyncedAt === null || subject.episodes.length === 0;

  if (needsEnrich) {
    try {
      await enrichSubject(subjectId, {
        userId: user?.id,
        accessToken: await bgmAccessTokenFor(user),
      });
      subject = await prisma.subject.findUnique({
        where: { id: subjectId },
        include: { episodes: { orderBy: { sort: "asc" } } },
      });
    } catch {
      subject = null;
    }
  }

  if (!subject) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">条目 {subjectId}</h1>
        <p className="alert alert-warn">
          无法从 Bangumi 获取该条目。可能是网络问题或条目 ID 不存在。
        </p>
        <Link href="/" className="text-sm text-primary underline">
          返回找番
        </Link>
      </div>
    );
  }

  const episodeIds = subject.episodes.map((episode) => episode.id);
  const [counts, schoolCounts, collection, enabledSources] = await Promise.all([
    countByEpisodeIds(episodeIds),
    user
      ? countByEpisodeIds(episodeIds, user.schoolId)
      : Promise.resolve({} as Record<number, number>),
    user
      ? prisma.collection.findUnique({
          where: { userId_subjectId: { userId: user.id, subjectId } },
        })
      : Promise.resolve(null),
    listSources(true).then((sources) => sources.length).catch(() => 0),
  ]);

  const episodes: EpisodeItem[] = subject.episodes.map((episode) => ({
    id: episode.id,
    sort: episode.sort,
    ep: episode.ep,
    name: episode.name,
    nameCn: episode.nameCn,
    airdate: episode.airdate?.toISOString().slice(0, 10) ?? null,
    duration: episode.duration,
    danmakuCount: counts[episode.id] ?? 0,
    schoolDanmakuCount: schoolCounts[episode.id] ?? 0,
  }));

  return (
    <div className="relative space-y-8">
      {/*
        封面虚化背景（`SubjectBlurredBackground`）—— Animeko 详情页最显眼的
        视觉标志。放在文档流之外并 `pointer-events: none`，纯粹是装饰。
        用 `img` 而非 `next/image`：它是被 `blur(32px)` 处理的纯色块，
        优化与响应式尺寸都没有意义，反而多一次布局计算。
      */}
      {subject.coverUrl && (
        <div className="detail-backdrop" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={subject.coverUrl} alt="" className="detail-backdrop__image" />
          <div className="detail-backdrop__scrim" />
        </div>
      )}

      <section className="relative flex flex-col gap-6 sm:flex-row">
        {subject.coverUrl && (
          <Image
            src={subject.coverUrl}
            alt={subject.nameCn ?? subject.name}
            width={849}
            height={1200}
            priority
            // Bangumi 原图比例 849:1200，与卡片的 9:16 裁切不同
            sizes="180px"
            className="poster-image h-auto w-36 shrink-0 rounded-lg shadow-lg sm:w-45"
          />
        )}

        <div className="min-w-0 space-y-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-normal leading-tight">
              {subject.nameCn || subject.name}
            </h1>
            <p className="text-sm text-on-surface-variant">{subject.name}</p>
          </div>

          {/* 评分区：大数字 + 五星 + 排名/人数 */}
          {subject.score ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="rating-score">{subject.score.toFixed(1)}</span>
              <span className="rating-stars" aria-label={`${(subject.score / 2).toFixed(1)} 星`}>
                {[1, 2, 3, 4, 5].map((star) => (
                  <IconStar key={star} size={18} filled={subject.score! / 2 >= star - 0.5} />
                ))}
              </span>
              <span className="text-sm text-on-surface-variant">
                {subject.rank ? `#${subject.rank} ` : ""}
                {subject.airDate ? `首播 ${subject.airDate.toISOString().slice(0, 10)}` : "未定档"}
              </span>
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">
              Bangumi 暂无评分
              {subject.airDate ? ` · 首播 ${subject.airDate.toISOString().slice(0, 10)}` : ""}
            </p>
          )}

          <CollectionPicker
            subjectId={subject.id}
            initialStatus={(collection?.type as CollectionStatusValue | undefined) ?? null}
            canInteract={user !== null}
            bgmBound={user?.bgmBound ?? false}
          />

          {collection?.rating != null && (
            <p className="text-sm text-primary">你的评分：{collection.rating} 分</p>
          )}

          {/* 简介长文折叠 —— Animeko 的 `SubjectSummarySection` 默认只显示 5 行 */}
          {subject.summary && (
            <details className="group max-w-2xl">
              <summary className="cursor-pointer text-sm text-on-surface-variant marker:text-outline">
                <span className="group-open:hidden">展开简介</span>
                <span className="hidden group-open:inline">收起简介</span>
              </summary>
              <p className="mt-2 whitespace-pre-wrap text-sm text-on-surface-variant">
                {subject.summary}
              </p>
            </details>
          )}

          <p className="text-xs text-on-surface-variant">
            条目与章节元数据来自 Bangumi；弹幕与评论为本站自建内容，可按本校筛选。
          </p>
        </div>
      </section>

      <JellyfinPanel
        subjectId={subject.id}
        bgmEpisodes={episodes.map((episode) => ({
          id: episode.id,
          sort: episode.sort,
          ep: episode.ep,
        }))}
        canInteract={user !== null}
        hasConnections={user?.jellyfinConnected ?? false}
      />

      <ExternalResources
        subjectId={subject.id}
        sourceCount={enabledSources}
        hasConnections={user?.jellyfinConnected ?? false}
        bgmEpisodes={episodes.map((episode) => ({
          id: episode.id,
          sort: episode.sort,
          ep: episode.ep,
        }))}
        canInteract={user !== null}
      />

      <EpisodeWorkspace
        subjectId={subject.id}
        episodes={episodes}
        canInteract={user !== null}
        schoolId={user?.schoolId}
        bgmBound={user?.bgmBound ?? false}
        hasPlayer={user?.jellyfinConnected ?? false}
      />
    </div>
  );
}

/**
 * 取该用户的 BGM access token，用于访问条目时同步其单集进度。
 *
 * 失败一律返回 undefined 而**不抛错** —— 令牌过期或上游抖动不该让条目页打不开，
 * 大不了这次不同步进度，下次访问会再试。
 */
async function bgmAccessTokenFor(user: SessionUser | null): Promise<string | undefined> {
  if (!user?.bgmBound) return undefined;
  try {
    const headerList = await headers();
    const host = headerList.get("host");
    const origin = host ? `http://${host}` : "http://localhost:3100";
    const { accessToken } = await getFreshBgmAccessToken(user.id, origin);
    return accessToken;
  } catch {
    return undefined;
  }
}
