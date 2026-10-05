import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import EpisodeWorkspace, { type EpisodeItem } from "@/components/episode-workspace";
import ExternalResources from "@/components/external-resources";
import SubjectAside from "@/components/subject-aside";
import SubjectSidebar from "@/components/subject-sidebar";
import JellyfinPanel from "@/components/jellyfin-panel";
import { CollectionStatus, type CollectionStatusValue } from "@/lib/collection";
import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { countByEpisodeIds } from "@/lib/danmaku/repository";
import { listSources } from "@/lib/media/service";
import { listReviews } from "@/lib/review/repository";
import { histogramBars } from "@/lib/subject/rating";
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
    include: { episodes: { orderBy: { sort: "asc" } }, persons: { orderBy: { sort: "asc" } } },
  });

  /*
   * 访问时补齐：本地只有轻量数据（`detailSyncedAt` 为 null）、没有章节，
   * **或还没同步过制作人员**时，去上游拉齐并缓存。已完整的条目直接走本地。
   *
   * 人员这一条与 `enrichSubject` 内部的判据必须一致：那是回填用的 ——
   * 在加入人员同步之前缓存过的条目 `detailSyncedAt` 有值、章节也有，
   * 只看前两项就永远不会再补，右栏的评分与制作人员会一直是空的。
   */
  const needsEnrich =
    !subject ||
    subject.detailSyncedAt === null ||
    subject.episodes.length === 0 ||
    subject.staffSyncedAt === null;

  if (needsEnrich) {
    try {
      await enrichSubject(subjectId, {
        userId: user?.id,
        accessToken: await bgmAccessTokenFor(user),
      });
      subject = await prisma.subject.findUnique({
        where: { id: subjectId },
        include: { episodes: { orderBy: { sort: "asc" } }, persons: { orderBy: { sort: "asc" } } },
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
  const [counts, schoolCounts, collection, enabledSources, collectionStats, hotReviews] =
    await Promise.all([
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
      /*
       * 全站收藏统计 —— 「在看人数」的数据来源。
       *
       * 用 groupBy 让数据库只回三行计数，而不是把该条目的全部收藏记录拉回来
       * 再在 JS 里数（热门条目可能有上万条）。
       */
      prisma.collection
        .groupBy({ by: ["type"], where: { subjectId }, _count: { _all: true } })
        .then((rows) => {
          const byType = new Map(rows.map((row) => [row.type, row._count._all]));
          return {
            wish: byType.get(CollectionStatus.Wish) ?? 0,
            doing: byType.get(CollectionStatus.Doing) ?? 0,
            done: byType.get(CollectionStatus.Done) ?? 0,
          };
        })
        .catch(() => ({ wish: 0, doing: 0, done: 0 })),
      // 右栏「热门评价」按点赞排序
      listReviews({ subjectId, sort: "hot", limit: 3 }).catch(() => []),
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

  const bars = histogramBars(subject.ratingHistogram);

  return (
    <div className="relative">
      {/*
        封面虚化背景（`SubjectBlurredBackground`）—— Animeko 详情页最显眼的
        视觉标志。放在文档流之外并 `pointer-events: none`，纯粹是装饰。
        用 `img` 而非 `next/image`：它是被 `blur(32px)` 处理的纯色块，
        优化与响应式尺寸都没有意义。
      */}
      {subject.coverUrl && (
        <div className="detail-backdrop" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={subject.coverUrl} alt="" className="detail-backdrop__image" />
          <div className="detail-backdrop__scrim" />
        </div>
      )}

      {/*
        三栏布局（`SubjectDetailsMultiColumnPage`）：
        左栏 = 封面 / 收藏 / 统计 / 作品信息 / 标签
        中栏 = 简介 + 章节 + 评论
        右栏 = 评分（含直方图）/ 热门评价 / 制作人员

        窄屏时退化为单列，顺序为 左 → 中 → 右 —— 因为左栏含封面与收藏按钮，
        那是最需要在首屏出现的东西。CSS Grid 的自动排布正好是这个顺序。
      */}
      <div className="detail-layout animate-rise relative">
        <SubjectSidebar
          subject={{
            id: subject.id,
            name: subject.name,
            nameCn: subject.nameCn,
            coverUrl: subject.coverUrl,
            airDate: subject.airDate,
            score: subject.score,
            rank: subject.rank,
            ratingTotal: subject.ratingTotal,
            tags: subject.tags,
          }}
          episodeCount={subject.episodes.length}
          stats={collectionStats}
          bgmCounts={{
            wish: subject.bgmWish,
            doing: subject.bgmDoing,
            done: subject.bgmDone,
            onHold: subject.bgmOnHold,
            dropped: subject.bgmDropped,
          }}
          myStatus={(collection?.type as CollectionStatusValue | undefined) ?? null}
          canInteract={user !== null}
          bgmBound={user?.bgmBound ?? false}
          tagHref={(tag) => `/?tags=${encodeURIComponent(tag)}`}
        />

        <div className="detail-column">
          {/* ---------------------------------------------------------- 简介 */}
          {subject.summary && (
            <section className="panel">
              <h2 className="detail-section-title">简介</h2>
              {/*
                默认折叠 —— Animeko 的 `SubjectSummarySection` 只显示 5 行。
                简介常有几百字，全展开会把章节列表推到屏幕外。
              */}
              <details className="group">
                <summary className="cursor-pointer text-sm text-on-surface-variant marker:text-outline">
                  <span className="group-open:hidden">展开简介</span>
                  <span className="hidden group-open:inline">收起简介</span>
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-on-surface-variant">
                  {subject.summary}
                </p>
              </details>
            </section>
          )}

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

        <SubjectAside
          ratingScore={subject.score}
          rank={subject.rank}
          ratingTotal={subject.ratingTotal}
          bars={bars}
          reviews={hotReviews}
          persons={subject.persons}
          schoolId={user?.schoolId}
          allReviewsHref={`#reviews`}
        />
      </div>
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
