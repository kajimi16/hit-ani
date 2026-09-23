import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";

export const metadata: Metadata = {
  title: "找番 · hit-ani",
};

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
  const sort = (["match", "heat", "rank", "score"] as const).includes(
    params.sort as never,
  )
    ? (params.sort as "match" | "heat" | "rank" | "score")
    : "match";

  const PAGE_SIZE = 24;
  const rawPage = Number(params.page ?? 1);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const result = keyword
    ? await searchSubjects(
        {
          keyword,
          sort,
          filter: { type: [SubjectType.Anime] as never, ...(tags.length ? { tag: tags } : {}), nsfw: false },
        },
        { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
      ).catch(() => null)
    : null;

  const totalPages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1;
  /** 构造分页链接：保留当前筛选条件，只换 page。 */
  const pageHref = (target: number) => {
    const search = new URLSearchParams();
    search.set("keyword", keyword);
    if (params.tags) search.set("tags", params.tags);
    if (sort !== "match") search.set("sort", sort);
    if (target > 1) search.set("page", String(target));
    return `/?${search.toString()}`;
  };

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h1 className="text-2xl font-semibold">找番</h1>
        <p className="text-sm text-neutral-400">
          条目数据来自 Bangumi；弹幕与评论由本站自建，可按本校筛选。
        </p>

        <form className="flex flex-wrap gap-3" action="/" method="get">
          <input
            name="keyword"
            defaultValue={keyword}
            placeholder="搜索番剧名，例如：魔法少女"
            className="min-w-64 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <input
            name="tags"
            defaultValue={params.tags ?? ""}
            placeholder="标签（逗号分隔，且关系）"
            className="min-w-52 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <select
            name="sort"
            defaultValue={sort}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          >
            <option value="match">匹配度</option>
            <option value="heat">收藏人数</option>
            <option value="rank">排名</option>
            <option value="score">评分</option>
          </select>
          <button
            type="submit"
            className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            搜索
          </button>
        </form>
      </section>

      {!keyword && (
        <section className="rounded border border-neutral-800 bg-neutral-900/40 p-5 text-sm text-neutral-400">
          <p className="font-medium text-neutral-200">还没有搜索关键词</p>
          <p className="mt-2">
            试试搜索「魔法少女」「机战」，或直接打开种子条目{" "}
            <Link href="/subjects/8" className="text-sky-400 underline">
              反叛的鲁路修
            </Link>{" "}
            查看弹幕与校内筛选效果。
          </p>
        </section>
      )}

      {keyword && result === null && (
        <section className="rounded border border-red-900 bg-red-950/40 p-5 text-sm text-red-300">
          Bangumi 搜索失败，请稍后重试。
        </section>
      )}

      {result && (
        <section className="space-y-4">
          <p className="text-sm text-neutral-400">
            共 {result.total} 个结果，本页 {result.data.length} 个
           </p>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {result.data.map((item, index) => (
              <li key={item.id}>
                <Link
                  href={`/subjects/${item.id}`}
                  className="block overflow-hidden rounded border border-neutral-800 bg-neutral-900 transition hover:border-sky-600"
                >
                  {item.images?.common && (
                    <Image
                      src={item.images.common}
                      alt={item.name_cn || item.name}
                      width={300}
                      height={400}
                      priority={index < 4}
                      sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                      className="aspect-[3/4] w-full object-cover"
                    />
                  )}
                  <div className="space-y-1 p-3">
                    <p className="line-clamp-2 text-sm font-medium">
                      {item.name_cn || item.name}
                    </p>
                    <p className="text-xs text-neutral-500">
                      {item.date || "未定档"} ·{" "}
                      {item.rating?.score ? item.rating.score.toFixed(1) : "暂无评分"}
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {totalPages > 1 && (
            <nav className="flex items-center justify-center gap-2 pt-2 text-sm">
              {page > 1 && (
                <Link
                  href={pageHref(page - 1)}
                  className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800"
                >
                  上一页
                </Link>
              )}
              {/*
                只给「上一页 / 下一页」+ 当前页码，不做数字罗列 ——
                番剧搜索常有几十页，罗列出来反而是噪音。
              */}
              <span className="px-2 text-neutral-500">
                {page} / {totalPages}
              </span>
              {page < totalPages && (
                <Link
                  href={pageHref(page + 1)}
                  className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800"
                >
                  下一页
                </Link>
              )}
              {page !== 1 && (
                <Link href={pageHref(1)} className="ml-2 text-xs text-neutral-500 underline">
                  回到第一页
                </Link>
              )}
            </nav>
          )}
        </section>
      )}
    </div>
  );
}
