import type { Metadata } from "next";
import Link from "next/link";
import SubjectCard from "@/components/subject-card";
import { IconCalendar, IconSearch } from "@/components/icons";
import { getSessionUser } from "@/lib/auth/session";
import { CollectionStatus } from "@/lib/collection";
import { prisma } from "@/lib/prisma";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";

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

  const PAGE_SIZE = 24;
  const rawPage = Number(params.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const isSearching = keyword.length > 0 || tags.length > 0;
  const user = await getSessionUser();

  /**
   * 三个分区并行取数。
   *
   * 空关键词时只查两次上游（Hero 8 条 + 推荐 24 条），用 offset 错开避免
   * 两处出现同一批条目。搜索时只查一次 —— 此时页面上只有结果网格。
   */
  const [hero, recommended, watching] = await Promise.all([
    isSearching
      ? Promise.resolve(null)
      : searchSubjects(
          {
            keyword: "",
            sort: "heat",
            filter: { type: [SubjectType.Anime] as never, air_date: [`>=${recentCutoff()}`], nsfw: false },
          },
          { limit: HERO_COUNT, offset: 0 },
        ).catch(() => null),
    searchSubjects(
      isSearching
        ? {
            keyword,
            sort,
            filter: {
              type: [SubjectType.Anime] as never,
              ...(tags.length ? { tag: tags } : {}),
              nsfw: false,
            },
          }
        : {
            keyword: "",
            sort: "heat",
            filter: { type: [SubjectType.Anime] as never, air_date: [`>=${recentCutoff()}`], nsfw: false },
          },
      {
        limit: PAGE_SIZE,
        offset: isSearching ? (page - 1) * PAGE_SIZE : HERO_COUNT,
      },
    ).catch(() => null),
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

  // 搜索模式下结果集是主网格；否则 Hero 单独占一块，主网格是推荐
  const grid = recommended;
  const totalPages = grid ? Math.max(1, Math.ceil(grid.total / PAGE_SIZE)) : 1;

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
    <div className="space-y-6">
      <section className="space-y-4">
        {!isSearching && (
          <div className="space-y-1">
            <h1 className="text-2xl font-normal">探索</h1>
            <p className="text-sm text-on-surface-variant">
              条目与章节数据来自 Bangumi；弹幕与评论由本站自建，可按本校筛选。
            </p>
          </div>
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
          <div className="hero-carousel">
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
          </div>
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
          <div className="card-row">
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
          </div>
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

          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-2 pt-6">
              {page > 1 && (
                <Link href={pageHref(page - 1)} className="btn btn-ghost btn-sm">
                  ← 上一页
                </Link>
              )}
              {/*
                只给「上一页 / 下一页」+ 当前页码，不做数字罗列 ——
                番剧搜索常有几十页，罗列出来反而是噪音。
              */}
              <span className="px-3 font-mono text-xs text-on-surface-variant">
                {page} / {totalPages}
              </span>
              {page < totalPages && (
                <Link href={pageHref(page + 1)} className="btn btn-ghost btn-sm">
                  下一页 →
                </Link>
              )}
            </nav>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * 「近期」的起始日期 —— 取过去一年。
 *
 * 不取当季：当季作品数量太少（一季约 30 部），撑不满首页网格；
 * 一年窗口既有当季也有刚完结的高热作品。
 */
function recentCutoff(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}
