import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";

export const metadata: Metadata = {
  title: "找番",
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

/** 搜索走 BGM `POST /v0/search/subjects`，SSR 直出，无需客户端 JS。 */
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

  // 没有关键词时也查一批热门 —— 空着的主页是最差的落地面。
  // 用「收藏人数」排序拿当季与经典的热门作品。
  const query = keyword || tags.length > 0 ? keyword : "";
  const result = await searchSubjects(
    {
      keyword: query,
      sort: keyword ? sort : "heat",
      filter: {
        type: [SubjectType.Anime] as never,
        ...(tags.length ? { tag: tags } : {}),
        ...(keyword ? {} : { air_date: [`>=${recentCutoff()}`] }),
        nsfw: false,
      },
    },
    { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
  ).catch(() => null);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  const isSearching = keyword.length > 0 || tags.length > 0;

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

  /** 快捷标签链接：点一下即按该标签筛选。 */
  const tagHref = (tag: string) => `/?tags=${encodeURIComponent(tag)}`;

  return (
    <div className="space-y-10">
      {/* ---------------------------------------------------------------- 搜索区 */}
      <section className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {isSearching ? "搜索结果" : "找番"}
          </h1>
          <p className="text-sm text-ink-muted">
            条目与章节数据来自 Bangumi；弹幕与评论由本站自建，可按本校筛选。
          </p>
        </div>

        {/*
          搜索控件做成一个整体：输入框与按钮贴合成一个视觉单元，
          比四个各自漂浮的控件更容易理解「这是一次搜索」。
        */}
        <form action="/" method="get" className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <span
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
              >
                <SearchIcon />
              </span>
              <input
                name="keyword"
                defaultValue={keyword}
                placeholder="搜索番剧名，例如：魔法少女"
                className="input pl-9"
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

            <select name="sort" defaultValue={sort} className="input sm:w-32" aria-label="排序方式">
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <button type="submit" className="btn btn-primary sm:px-6">
              搜索
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-faint">快捷筛选</span>
            {QUICK_TAGS.map((tag) => (
              <Link key={tag} href={tagHref(tag)} className="badge transition-colors hover:bg-accent-dim hover:text-accent">
                {tag}
              </Link>
            ))}
            {isSearching && (
              <Link href="/" className="ml-1 text-xs text-ink-faint underline underline-offset-2 hover:text-ink-muted">
                清除筛选
              </Link>
            )}
          </div>
        </form>
      </section>

      {/* ---------------------------------------------------------------- 失败 */}
      {result === null && (
        <p className="alert alert-danger">
          Bangumi 搜索失败。上游可能暂时不可用，稍后重试即可。
        </p>
      )}

      {/* ---------------------------------------------------------------- 结果 */}
      {result !== null && (
        <section className="space-y-5">
          <div className="flex flex-wrap items-baseline gap-3">
            <h2 className="section-title">
              {isSearching ? "找到的条目" : "近期热门"}
              <span className="text-sm font-normal text-ink-faint">
                {result.total} 个
              </span>
            </h2>
            {totalPages > 1 && (
              <span className="ml-auto font-mono text-xs text-ink-faint">
                第 {page} / {totalPages} 页
              </span>
            )}
          </div>

          {result.data.length === 0 ? (
            <p className="panel text-sm text-ink-muted">
              没有匹配的条目。试试更短的关键词，或去掉标签筛选。
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-5">
              {result.data.map((item, index) => (
                <li key={item.id}>
                  <Link href={`/subjects/${item.id}`} className="poster-card">
                    <div className="relative">
                      {item.images?.common ? (
                        <Image
                          src={item.images.common}
                          alt={item.name_cn || item.name}
                          width={300}
                          height={400}
                          // 首屏前几张立即加载，其余懒加载 —— 兼顾 LCP 与带宽
                          priority={index < 5}
                          sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 20vw"
                          className="poster-image"
                        />
                      ) : (
                        <div className="poster-image" />
                      )}

                      {/*
                        评分做成角标压在封面上。做在文字区里的话，
                        用户扫视网格时很难比较分数 —— 而这是选片的主要依据。
                      */}
                      {item.rating?.score ? (
                        <span className="absolute right-2 top-2 rounded-md bg-canvas/80 px-1.5 py-0.5 font-mono text-xs font-medium text-warn backdrop-blur-sm">
                          {item.rating.score.toFixed(1)}
                        </span>
                      ) : null}
                    </div>

                    <div className="space-y-1 p-2.5">
                      <p className="line-clamp-2 text-sm leading-snug text-ink">
                        {item.name_cn || item.name}
                      </p>
                      <p className="truncate text-xs text-ink-faint">
                        {item.date || "未定档"}
                        {item.eps ? ` · ${item.eps} 集` : ""}
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {/* ------------------------------------------------------------ 分页 */}
          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-2 pt-2">
              {page > 1 && (
                <Link href={pageHref(page - 1)} className="btn btn-ghost btn-sm">
                  ← 上一页
                </Link>
              )}
              {/*
                只给「上一页 / 下一页」+ 当前页码，不做数字罗列 ——
                番剧搜索常有几十页，罗列出来反而是噪音。
              */}
              <span className="px-3 font-mono text-xs text-ink-faint">
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
 * 热门榜单的起始日期 —— 「近期」取过去一年。
 *
 * 不取当季：当季作品数量太少（一季约 30 部），撑不满首页网格；
 * 一年窗口既有当季也有刚完结的高热作品。
 */
function recentCutoff(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
