import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { COLLECTION_STATUSES, statusBySlug } from "@/lib/collection";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * 我的追番：固定分成五种状态。
 *
 * 五种分组**始终全部渲染**（哪怕为空）—— 用户要的是一眼看清「哪些状态有内容、哪些是空的」，
 * 只渲染非空分组会让空状态消失、也让分组数随数据变化，无法形成稳定心智。
 *
 * 状态数值的权威映射见 `@/lib/collection`（2=看过、3=在看，顺序反直觉，曾写错过）。
 */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const focused = statusBySlug(params.status);

  const collections = await prisma.collection.findMany({
    where: {
      userId: user.id,
      ...(focused ? { type: focused.value } : {}),
    },
    orderBy: { updatedAt: "desc" },
    include: {
      subject: {
        select: {
          id: true,
          name: true,
          nameCn: true,
          coverUrl: true,
          score: true,
          episodes: { select: { id: true } },
        },
      },
    },
  });

  /** 观看进度：已看集数 / 总集数。只看当前用户自己的进度记录。 */
  const watchedBySubject = new Map<number, number>();
  if (collections.length > 0) {
    const progressRows = await prisma.episodeProgress.findMany({
      where: {
        userId: user.id,
        type: 2, // EpisodeCollectionType.Done（此处语义与条目收藏不同）
        episode: { subjectId: { in: collections.map((item) => item.subjectId) } },
      },
      select: { episode: { select: { subjectId: true } } },
    });
    for (const row of progressRows) {
      const subjectId = row.episode.subjectId;
      watchedBySubject.set(subjectId, (watchedBySubject.get(subjectId) ?? 0) + 1);
    }
  }

  // 各状态计数：一次 groupBy 拿全，避免五次查询
  const counts = await prisma.collection.groupBy({
    by: ["type"],
    where: { userId: user.id },
    _count: { _all: true },
  });
  const countByType = new Map(counts.map((row) => [row.type, row._count._all]));

  const total = [...countByType.values()].reduce((sum, n) => sum + n, 0);

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">我的追番</h1>
        <p className="text-sm text-ink-muted">
          共 {total} 部。
          {user.bgmBound ? (
            <>
              已绑定 Bangumi（{user.bgmUsername}），可在{" "}
              <Link href="/settings" className="text-accent underline">
                设置
              </Link>{" "}
              里重新导入。
            </>
          ) : (
            <>
              尚未绑定 Bangumi，
              <Link href="/settings" className="mx-1 text-accent underline">
                去绑定
              </Link>
              后可一键导入全部收藏。
            </>
          )}
        </p>
      </section>

      {/* 五种状态的分组导航：常显，含计数 */}
      <nav className="flex flex-wrap gap-2">
        <Link
          href="/library"
          className={`rounded border px-3 py-1.5 text-sm transition ${
            focused === null
              ? "border-accent bg-accent-dim text-accent"
              : "border-line bg-surface hover:border-line-strong"
          }`}
        >
          全部
          <span className="ml-2 text-xs text-ink-faint">{total}</span>
        </Link>
        {COLLECTION_STATUSES.map((meta) => {
          const active = focused?.value === meta.value;
          return (
            <Link
              key={meta.slug}
              href={`/library?status=${meta.slug}`}
              className={`rounded border px-3 py-1.5 text-sm transition ${
                active
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-line bg-surface hover:border-line-strong"
              }`}
            >
              {meta.label}
              <span className="ml-2 text-xs text-ink-faint">
                {countByType.get(meta.value) ?? 0}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* 分组列表：聚焦单一状态时只渲染该组，否则五组全渲染（含空态） */}
      {(focused ? [focused] : COLLECTION_STATUSES).map((meta) => {
        const items = collections.filter((item) => item.type === meta.value);
        return (
          <section key={meta.slug} className="space-y-4">
            <h2 className="flex items-baseline gap-3 text-lg font-medium">
              {meta.label}
              <span className="text-sm text-ink-faint">
                {countByType.get(meta.value) ?? 0} 部
              </span>
            </h2>

            {items.length === 0 ? (
              <p className="panel text-sm text-ink-faint">
                {meta.emptyHint}
              </p>
            ) : (
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
                {items.map((item) => {
                  const watched = watchedBySubject.get(item.subjectId) ?? 0;
                  const totalEpisodes = item.subject.episodes.length;
                  return (
                    <li key={item.id}>
                      <Link
                        href={`/subjects/${item.subjectId}`}
                        className="block overflow-hidden rounded border border-line bg-surface transition hover:border-accent"
                      >
                        {item.subject.coverUrl && (
                          <Image
                            src={item.subject.coverUrl}
                            alt={item.subject.nameCn ?? item.subject.name}
                            width={300}
                            height={400}
                            sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                            className="aspect-[3/4] w-full object-cover"
                          />
                        )}
                        <div className="space-y-1 p-3">
                          <p className="line-clamp-2 text-sm">
                            {item.subject.nameCn || item.subject.name}
                          </p>
                          <p className="text-xs text-ink-faint">
                            {item.rating ? `${item.rating} 分` : "未评分"}
                            {totalEpisodes > 0 && (
                              <span className="ml-2 font-mono">
                                {watched}/{totalEpisodes}
                              </span>
                            )}
                          </p>

                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
