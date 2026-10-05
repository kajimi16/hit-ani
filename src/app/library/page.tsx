import { redirect } from "next/navigation";
import { LibraryGridCard, LibraryListRow, type LibraryItem } from "@/components/library-views";
import { IconChevron } from "@/components/icons";
import { getSessionUser } from "@/lib/auth/session";
import {
  COLLECTION_STATUSES,
  statusBySlug,
  type CollectionStatusValue,
} from "@/lib/collection";
import {
  LIBRARY_GROUP_PREVIEW,
  LIBRARY_PAGE_SIZE,
  LIBRARY_SORTS,
  LIBRARY_VIEWS,
  libraryHref,
  parseLibraryQuery,
} from "@/lib/library-query";
import { collectionOrderBy } from "@/lib/library-sort";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/*
 * 本页所有链接都用**普通 `<a>`** 而不是 `next/link`。
 *
 * 原因：状态筛选、排序、视图、分页全都是「同路径 + 换 query」的导航，而这类
 * 导航在本机实测会静默失效 —— `Link` 的处理器确实跑了（`defaultPrevented`
 * 为 true），但客户端路由不提交，URL 与内容都不变，也不报错。详情见
 * `docs/STATUS.md` 里关于分页那次的记录。
 *
 * 本页每次渲染都要查库，客户端路由省下的收益本就有限；换成普通链接后
 * **必定生效**，最坏只是退化成整页加载，不会变成「点了没反应」。
 */

/**
 * 我的追番。
 *
 * 五种状态分组**始终全部渲染**（哪怕为空）—— 用户要的是一眼看清「哪些状态
 * 有内容、哪些是空的」。状态数值的权威映射见 `@/lib/collection`
 * （2=看过、3=在看，顺序反直觉，曾写错过）。
 *
 * ## 两个视图的取舍
 *
 * - **全部**（不聚焦某状态）：每组只给前 `LIBRARY_GROUP_PREVIEW` 条，其余走
 *   「查看全部 N 部」进聚焦视图。此前这里一次渲染 386 条，实测 HTML 达 1.14 MB、
 *   386 个 `<img>` —— 这才是用户报的「全量加载导致卡顿」的根因（数据库查询
 *   只用 29ms，与传输和渲染无关）。
 * - **聚焦某状态**：分页，每页 `LIBRARY_PAGE_SIZE` 条，同样的理由。
 */
export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string; view?: string; page?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const params = await searchParams;
  const focused = statusBySlug(params.status);
  const query = parseLibraryQuery(params);

  /**
   * 取数的两条路径。
   *
   * - **聚焦单一状态**：一次查询，按页取 `LIBRARY_PAGE_SIZE` 条。
   * - **全部**：**每组各查一次**，每组只取前 `LIBRARY_GROUP_PREVIEW` 条。
   *
   * 「全部」这里一开始写成「一次取 60 行，再在内存里按组切分」，那是错的 ——
   * 排序是全局的，前 60 行很可能全落在同一个状态里，另外四组因此显示为空，
   * 而它们其实有内容（实测「全部」只渲染出约 14 张卡片）。每组一次查询虽然
   * 变成五次往返，但每次只回十几行，代价远小于把几百条塞进 RSC 载荷。
   */
  const include = {
    subject: {
      select: {
        id: true,
        name: true,
        nameCn: true,
        coverUrl: true,
        score: true,
        rank: true,
        // 只要计数，不要把 6000+ 个 episode 行传进 RSC 载荷
        _count: { select: { episodes: true } },
      },
    },
  } as const;

  /** 每个状态取一次；聚焦时只取该状态，且按页取。 */
  const loadGroup = (type: CollectionStatusValue, take: number, skip = 0) =>
    prisma.collection.findMany({
      where: { userId: user.id, type },
      orderBy: collectionOrderBy(query.sort),
      take,
      skip,
      include,
    });

  const [groupRows, counts, totalForFocused] = await Promise.all([
    focused
      ? loadGroup(focused.value, LIBRARY_PAGE_SIZE, (query.page - 1) * LIBRARY_PAGE_SIZE).then(
          (rows) => new Map([[focused.value, rows]]),
        )
      : Promise.all(
          COLLECTION_STATUSES.map(
            async (meta) => [meta.value, await loadGroup(meta.value, LIBRARY_GROUP_PREVIEW)] as const,
          ),
        ).then((entries) => new Map(entries)),
    prisma.collection.groupBy({
      by: ["type"],
      where: { userId: user.id },
      _count: { _all: true },
    }),
    focused ? prisma.collection.count({ where: { userId: user.id, type: focused.value } }) : Promise.resolve(0),
  ]);

  /** 状态值 → 该组本次要渲染的行。 */
  const rowsByType = groupRows;
  const allRows = [...rowsByType.values()].flat();

  const countByType = new Map(counts.map((row) => [row.type, row._count._all]));

  /** 观看进度：已看集数。只看当前用户自己的进度记录。 */
  const watchedBySubject = new Map<number, number>();
  if (allRows.length > 0) {
    const progressRows = await prisma.episodeProgress.findMany({
      where: {
        userId: user.id,
        type: 2, // EpisodeProgress 的 Done（与条目收藏的语义不同）
        episode: { subjectId: { in: allRows.map((item) => item.subjectId) } },
      },
      select: { episode: { select: { subjectId: true } } },
    });
    for (const row of progressRows) {
      const subjectId = row.episode.subjectId;
      watchedBySubject.set(subjectId, (watchedBySubject.get(subjectId) ?? 0) + 1);
    }
  }



  // 显式标注键类型：Prisma 返回的 `type` 是 number，而标签表的键是字面量联合，
  // 不加会在 `get` 处报「number 不能赋给 CollectionStatusValue」。
  const statusLabelByValue = new Map<CollectionStatusValue, string>(
    COLLECTION_STATUSES.map((meta) => [meta.value, meta.label]),
  );

  const toItem = (row: (typeof allRows)[number]): LibraryItem => ({
    collectionId: row.id,
    subjectId: row.subjectId,
    title: row.subject.nameCn || row.subject.name,
    originalTitle: row.subject.name,
    coverUrl: row.subject.coverUrl,
    bgmScore: row.subject.score,
    myRating: row.rating,
    myComment: row.comment,
    bgmRank: row.subject.rank,
    watchedEpisodes: watchedBySubject.get(row.subjectId) ?? 0,
    totalEpisodes: row.subject._count.episodes,
    collectedAt: row.collectedAt?.toISOString() ?? null,
    statusLabel: statusLabelByValue.get(row.type as CollectionStatusValue) ?? "未知",
  });

  const hrefFor = (overrides: Partial<{ status: string; sort: typeof query.sort; view: typeof query.view; page: number }>) =>
    libraryHref({
      status: focused?.slug,
      sort: query.sort,
      view: query.view,
      ...overrides,
    });

  const totalPages = focused ? Math.max(1, Math.ceil(totalForFocused / LIBRARY_PAGE_SIZE)) : 1;
  const View = query.view === "list" ? "list" : "grid";

  return (
    <div className="animate-rise space-y-6">
      <h1 className="text-2xl font-normal">我的追番</h1>

      {/* ---------------------------------------------------------- 状态分组导航 */}
      <nav className="flex flex-wrap gap-2">
        <a
          href={hrefFor({ status: undefined, page: 1 })}
          className={`rounded border px-3 py-1.5 text-sm transition ${
            focused === null
              ? "border-primary bg-primary-container text-on-primary-container"
              : "border-outline-variant bg-surface-container-low hover:border-outline"
          }`}
        >
          全部
          <span className="ml-2 text-xs text-on-surface-variant">
            {[...countByType.values()].reduce((sum, n) => sum + n, 0)}
          </span>
        </a>
        {COLLECTION_STATUSES.map((meta) => {
          const active = focused?.value === meta.value;
          return (
            <a
              key={meta.slug}
              href={hrefFor({ status: meta.slug, page: 1 })}
              className={`rounded border px-3 py-1.5 text-sm transition ${
                active
                  ? "border-primary bg-primary-container text-on-primary-container"
                  : "border-outline-variant bg-surface-container-low hover:border-outline"
              }`}
            >
              {meta.label}
              <span className="ml-2 text-xs text-on-surface-variant">
                {countByType.get(meta.value) ?? 0}
              </span>
            </a>
          );
        })}
      </nav>

      {/* ---------------------------------------------------------- 排序 / 视图 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-on-surface-variant">排序</span>
          {LIBRARY_SORTS.map((option) => (
            <a
              key={option.value}
              href={hrefFor({ sort: option.value, page: 1 })}
              aria-current={query.sort === option.value ? "true" : undefined}
              className={`btn btn-sm ${query.sort === option.value ? "btn-primary" : "btn-ghost"}`}
            >
              {option.label}
            </a>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-on-surface-variant">视图</span>
          {LIBRARY_VIEWS.map((option) => (
            <a
              key={option.value}
              href={hrefFor({ view: option.value, page: 1 })}
              aria-current={query.view === option.value ? "true" : undefined}
              className={`btn btn-sm ${query.view === option.value ? "btn-primary" : "btn-ghost"}`}
            >
              {option.label}
            </a>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------- 分组列表 */}
      {(focused ? [focused] : COLLECTION_STATUSES).map((meta) => {
        // 聚焦时该组这一页的行；「全部」时该组的前 N 行 —— 按组取数已在上面完成。
        const shown = rowsByType.get(meta.value) ?? [];
        const total = countByType.get(meta.value) ?? 0;

        return (
          <section key={meta.slug} className="space-y-4">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-lg font-medium">{meta.label}</h2>
              <span className="text-sm text-on-surface-variant">{total} 部</span>
              {!focused && total > shown.length && (
                <a
                  href={hrefFor({ status: meta.slug, page: 1 })}
                  className="ml-auto text-xs text-primary hover:underline"
                >
                  查看全部 {total} 部 →
                </a>
              )}
            </div>

            {total === 0 ? (
              <p className="panel text-sm text-on-surface-variant">{meta.emptyHint}</p>
            ) : shown.length === 0 ? (
              // 聚焦并有数据、但当前页越界（用户手改 URL 到第 999 页）
              <p className="panel text-sm text-on-surface-variant">
                这一页没有内容。<a href={hrefFor({ page: 1 })} className="text-primary underline">回到第 1 页</a>
              </p>
            ) : View === "list" ? (
              <ul className="panel divide-y-0 p-0">
                {shown.map((row) => (
                  <LibraryListRow key={row.id} item={toItem(row)} />
                ))}
              </ul>
            ) : (
              <div className="subject-grid">
                {shown.map((row) => (
                  <LibraryGridCard key={row.id} item={toItem(row)} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {/* ---------------------------------------------------------- 分页（仅聚焦视图） */}
      {focused && totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2 pt-2">
          {query.page > 1 && (
            <a href={hrefFor({ page: query.page - 1 })} className="btn btn-ghost btn-sm">
              <IconChevron size={16} direction="left" />
              上一页
            </a>
          )}
          <span className="px-3 font-mono text-xs text-on-surface-variant">
            {query.page} / {totalPages}
          </span>
          {query.page < totalPages && (
            <a href={hrefFor({ page: query.page + 1 })} className="btn btn-ghost btn-sm">
              下一页
              <IconChevron size={16} direction="right" />
            </a>
          )}
        </nav>
      )}
    </div>
  );
}
