import type { Metadata } from "next";
import Link from "next/link";
import ScrollRow from "@/components/scroll-row";
import SubjectCard from "@/components/subject-card";
import { IconCalendar, IconSearch } from "@/components/icons";
import { getSessionUser } from "@/lib/auth/session";
import { CollectionStatus } from "@/lib/collection";
import { prisma } from "@/lib/prisma";
import { SubjectType, searchSubjects, withRetry } from "@/lib/bgm/client";
import { cookies } from "next/headers";
import { BGM_MAX_PAGE_SIZE, pageCount, pageOffset } from "@/lib/bgm/paging";
import { recommendQuery } from "@/lib/bgm/recommend";
import { NSFW_COOKIE, nsfwFilterValue, parseNsfwCookie } from "@/lib/nsfw";

export const metadata: Metadata = {
  title: "探索",
};

/** 排序选项。抽出来是因为表单与链接构造都要用。 */
const SORTS = [
  { value: "match", label: "匹配度" },
  { value: "heat", label: "收藏人数" },
  { value: "rank", label: "排名" },
  { value: "score", label: "评分" },
] as const;

/** 空状态下的快捷标签 —— 给不愿打字的用户一个入口。 */
const QUICK_TAGS = ["机战", "日常", "奇幻", "恋爱", "科幻", "治愈"];


/**
 * 取一页上游数据，失败时重试并**记录真实原因**。
 *
 * 为什么要记：此前这里只是 `.catch(() => null)`，把错误整个吞掉。结果是
 * 「加载失败」这个提示背后具体是限流、连接被重置还是超时，服务端日志里
 * 一个字都没有 —— 用户报障时无从查起。
 *
 * 返回 `null` 而不是抛出：首页三个分区各自独立，一个失败不该让整页白屏。
 */
async function load<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  try {
    return await withRetry(fn, label, 2);
  } catch (error) {
    console.error(`[home] ${label} 加载失败：`, error);
    return null;
  }
}

/** Hero 轮播条数。对应 Animeko `TrendingSubjectsCarousel` 的 8 个占位。 */
const HERO_COUNT = 8;

/**
 * 探索页 —— 对应 Animeko 的 `ExplorationScreen`。
 *
 * 它是一列**分区流**，顺序固定为：
 * 1. 热门趋势（居中 Hero 轮播）
 * 2. 继续观看（横向滚动行）
 * 3. 推荐（自适应网格）
 *
 * 本实现保留这个顺序与形态。差异点：
 * - Animeko 的「推荐」是算法推荐；我们没有推荐系统，用 BGM 收藏人数排序
 *   补齐（少了算法黑箱，但至少是「大家在看什么」）
 * - 搜索是顶部常驻输入框（Animeko 放在侧栏 FAB 里）
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ keyword?: string; tags?: string; sort?: string; page?: string }>;
}) {
  const params = await searchParams;
  const keyword = (params.keyword ?? "").trim();
  const tags = (params.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  const sort = (SORTS.map((s) => s.value) as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as (typeof SORTS)[number]["value"])
    : "match";

  const rawPage = Number(params.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const isSearching = keyword.length > 0 || tags.length > 0;
  const user = await getSessionUser();

  /*
   * NSFW 过滤：偏好存在 cookie 里（设置页写入），因此服务端能直接读 ——
   * 这个值决定**请求哪些条目**，不能等客户端再补。
   * `nsfwFilterValue` 返回 undefined 时整个键都不传（见该函数说明）。
   */
  const nsfw = nsfwFilterValue(parseNsfwCookie((await cookies()).get(NSFW_COOKIE)?.value));

  /**
   * 三个分区并行取数。
   *
   * 空关键词时查两次上游（Hero 8 条 + 推荐一页），用 offset 错开避免两处
   * 出现同一批条目。搜索时只查一次 —— 此时页面上只有结果网格。
   */
  const [hero, recommended, watching] = await Promise.all([
    isSearching
      ? Promise.resolve(null)
      : load(() => searchSubjects(recommendQuery(), { limit: HERO_COUNT, offset: 0 }), "hero"),
    load(
      () =>
        searchSubjects(
          isSearching
            ? {
                keyword,
                sort,
                filter: {
                  type: [SubjectType.Anime] as never,
                  ...(tags.length ? { tag: tags } : {}),
                  ...(nsfw === undefined ? {} : { nsfw }),
                },
              }
            : recommendQuery(),
          {
            limit: BGM_MAX_PAGE_SIZE,
            // Hero 占掉前 8 条，推荐从第 9 条开始；搜索时没有 Hero，从头开始
            offset: pageOffset(page, isSearching ? 0 : HERO_COUNT),
          },
        ),
      "subjects",
    ),
    // 「继续观看」直接读本地库，不打上游
    user
      ? prisma.collection
          .findMany({
            where: { userId: user.id, type: CollectionStatus.Doing },
            orderBy: { updatedAt: "desc" },
            take: 12,
            include: { subject: { select: { id: true, name: true, nameCn: true, coverUrl: true } } },
          })
          .catch(() => [])
      : Promise.resolve([]),
  ]);

  const grid = recommended;
  const totalPages = grid ? pageCount(grid.total, isSearching ? 0 : HERO_COUNT) : 1;

  /** 构造分页链接：保留当前筛选条件，只换 page。 */
  const pageHref = (target: number) => {
    const search = new URLSearchParams();
    if (keyword) search.set("keyword", keyword);
    if (params.tags) search.set("tags", params.tags);
    if (sort !== "match") search.set("sort", sort);
    if (target > 1) search.set("page", String(target));
    const qs = search.toString();
    return qs ? `/?${qs}` : "/";
  };

  return (
    <div className="animate-rise space-y-6">
      <section className="space-y-4">
        {!isSearching && (
          <h1 className="text-2xl font-normal">探索</h1>
        )}

        <form action="/" method="get" className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <span
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
              >
                <IconSearch size={18} />
              </span>
              <input
                name="keyword"
                defaultValue={keyword}
                placeholder="搜索番剧名，例如：魔法少女"
                className="input pl-10"
                aria-label="搜索关键词"
              />
            </div>

            <input
              name="tags"
              defaultValue={params.tags ?? ""}
              placeholder="标签（逗号分隔）"
              className="input sm:w-44"
              aria-label="标签筛选"
            />

            {isSearching && (
              <select name="sort" defaultValue={sort} className="input sm:w-32" aria-label="排序方式">
                {SORTS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}

            <button type="submit" className="btn btn-primary sm:px-6">
              搜索
            </button>
          </div>

          {!isSearching && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-on-surface-variant">快捷筛选</span>
              {QUICK_TAGS.map((tag) => (
                <Link
                  key={tag}
                  href={`/?tags=${encodeURIComponent(tag)}`}
                  className="badge transition-colors hover:bg-primary-container hover:text-on-primary-container"
                >
                  {tag}
                </Link>
              ))}
            </div>
          )}
        </form>
      </section>

      {grid === null && (
        <p className="alert alert-danger">
          Bangumi 搜索失败。上游可能暂时不可用，稍后重试即可。
        </p>
      )}

      {/* ============================================================ 热门趋势
          对应 `TrendingSubjectsCarousel`：居中 Hero 轮播，
          区块标题右侧挂「时间表」按钮（Animeko 唯一的区块级跳转）。 */}
      {!isSearching && hero && hero.data.length > 0 && (
        <section>
          <div className="section-header">
            <h2 className="section-header__title">热门趋势</h2>
            <div className="ml-auto">
              <Link href="/schedule" className="btn btn-text btn-sm">
                <IconCalendar size={18} />
                时间表
              </Link>
            </div>
          </div>
          {/* 「每隔一段时间自动向左边挤压，右边进来一个」—— 6 秒一屏 */}
          <ScrollRow className="hero-carousel" label="热门趋势" autoAdvanceMs={6000}>
            {hero.data.map((item, index) => (
              <SubjectCard
                key={item.id}
                variant="hero"
                href={`/subjects/${item.id}`}
                title={item.name_cn || item.name}
                image={item.images?.common ?? null}
                subtitle={
                  item.rating?.score
                    ? `${item.rating.score.toFixed(1)} 分${item.rating.total ? ` · ${item.rating.total} 人评` : ""}`
                    : item.date || null
                }
                priority={index < 2}
                sizes="(max-width: 600px) 80vw, 300px"
              />
            ))}
          </ScrollRow>
        </section>
      )}

      {/* ============================================================ 继续观看
          对应 `FollowedSubjectsLazyRow`：横向滚动行，文字是观看进度。 */}
      {!isSearching && watching.length > 0 && (
        <section>
          <div className="section-header">
            <h2 className="section-header__title">继续观看</h2>
            <div className="ml-auto">
              <Link href="/library?status=doing" className="btn btn-text btn-sm">
                全部
              </Link>
            </div>
          </div>
          <ScrollRow className="card-row" label="继续观看">
            {watching.map((row) => (
              <SubjectCard
                key={row.id}
                href={`/subjects/${row.subject.id}`}
                title={row.subject.nameCn || row.subject.name}
                image={row.subject.coverUrl}
                subtitle="在看"
                sizes="160px"
              />
            ))}
          </ScrollRow>
        </section>
      )}

      {/* ============================================================ 推荐 / 结果 */}
      {grid !== null && (
        <section>
          <div className="section-header">
            <h2 className="section-header__title">
              {isSearching ? "搜索结果" : "推荐"}
              <span className="ml-3 align-middle text-sm text-on-surface-variant">
                {grid.total} 个
              </span>
            </h2>
            {isSearching && (
              <div className="ml-auto">
                <Link href="/" className="btn btn-text btn-sm">
                  清除筛选
                </Link>
              </div>
            )}
          </div>

          {grid.data.length === 0 ? (
            <p className="panel text-sm text-on-surface-variant">
              没有匹配的条目。试试更短的关键词，或去掉标签筛选。
            </p>
          ) : (
            <div className="subject-grid">
              {grid.data.map((item, index) => (
                <SubjectCard
                  key={item.id}
                  href={`/subjects/${item.id}`}
                  title={item.name_cn || item.name}
                  image={item.images?.common ?? null}
                  subtitle={
                    item.rating?.score
                      ? item.rating.score.toFixed(1)
                      : item.date?.slice(0, 4) || "未定档"
                  }
                  priority={index < 4}
                />
              ))}
            </div>
          )}

          {/*
            分页用**普通 `<a>`** 而不是 `<Link>`。

            为什么：翻页在本机实测会静默失效 —— React 的 `<Link>` 处理器确实
            跑了（`defaultPrevented` 变 true），但 Next 客户端路由没有提交这次
            导航，URL 与内容都不变，也不报错。多次实测下「有时成功、有时不动」。

            而这一页的全部内容都由 `searchParams` 决定、每次渲染都要打上游，
            客户端路由省下的那点收益本来就不成立。用普通链接换来**必定生效**：
            即使某个环境里客户端路由又出问题，也只是退化成整页加载，
            不会变成「点了没反应」。
          */}
          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-2 pt-6">
              {page > 1 && (
                <a href={pageHref(page - 1)} className="btn btn-ghost btn-sm">
                  ← 上一页
                </a>
              )}
              {/*
                只给「上一页 / 下一页」+ 当前页码，不做数字罗列 ——
                番剧搜索常有几十页，罗列出来反而是噪音。
              */}
              <span className="px-3 font-mono text-xs text-on-surface-variant">
                {page} / {totalPages}
              </span>
              {page < totalPages && (
                <a href={pageHref(page + 1)} className="btn btn-ghost btn-sm">
                  下一页 →
                </a>
              )}
            </nav>
          )}
        </section>
      )}
    </div>
  );
}

