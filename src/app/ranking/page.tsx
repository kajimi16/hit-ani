import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  DEFAULT_RANKING_TYPE,
  RANKING_PAGE_SIZE,
  RANKING_TYPES,
  listRanking,
} from "@/lib/subject/ranking";

export const metadata: Metadata = {
  title: "排行榜",
  description: "Bangumi 评分排名 —— 按口碑排序，而不是按热度",
};

export const dynamic = "force-dynamic";

export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; type?: string }>;
}) {
  const params = await searchParams;

  // 白名单：URL 上的 `type` 是不可信输入，非枚举值退回默认
  const requested = params.type ?? DEFAULT_RANKING_TYPE;
  const type = RANKING_TYPES.some((t) => t.value === requested) ? requested : DEFAULT_RANKING_TYPE;

  const parsedPage = Number(params.page);
  const page = Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  const { total, subjects, lastPage } = await listRanking({ type, page });

  /** 只换一个参数时保留另一个 —— 否则点「下一页」会跳回默认类型。 */
  const hrefFor = (next: { page?: number; type?: string }) => {
    const q = new URLSearchParams();
    const t = next.type ?? type;
    if (t !== DEFAULT_RANKING_TYPE) q.set("type", t);
    const p = next.page ?? 1;
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return qs ? `/ranking?${qs}` : "/ranking";
  };

  return (
    <div className="animate-rise space-y-5">
      <header className="space-y-1">
        <h1 className="text-2xl font-normal">排行榜</h1>
        <p className="text-sm text-on-surface-variant">
          按 Bangumi 评分排名，共 {total} 部在榜。名次取全站名次，因此筛选后不会连续。
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="类型筛选">
        {RANKING_TYPES.map((t) => {
          const active = t.value === type;
          return (
            <Link
              key={t.value}
              href={hrefFor({ type: t.value })}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "badge badge-accent"
                  : "badge transition-colors hover:bg-primary-container hover:text-on-primary-container"
              }
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {subjects.length === 0 ? (
        <p className="alert alert-warn">
          这个分类下还没有带排名的条目。排行榜数据在首次访问条目时从 Bangumi
          缓存，多看几部就会出现。
        </p>
      ) : (
        <ol className="space-y-1">
          {subjects.map((s, index) => (
            <li key={s.id}>
              <Link
                href={`/subjects/${s.id}`}
                className="flex items-center gap-3 rounded px-2 py-2 transition-colors hover:bg-surface-container"
              >
                {/*
                  显示**真实名次**而不是页面序号：翻到第 3 页时序号会从 101 开始，
                  而用户想知道的是「它在全站排第几」。前 3 名给主色，
                  让人扫一眼就能找到榜首。
                */}
                <span
                  className={
                    "w-10 shrink-0 text-right font-mono text-sm " +
                    (s.rank !== null && s.rank <= 3 ? "text-primary" : "text-on-surface-variant")
                  }
                >
                  {s.rank}
                </span>
                <span className="relative block h-[67px] w-12 shrink-0 overflow-hidden rounded bg-surface-container">
                  {s.coverUrl ? (
                    <Image
                      src={s.coverUrl}
                      alt=""
                      fill
                      sizes="48px"
                      className="object-cover"
                      // 首屏前几张立即加载，其余懒加载
                      priority={index < 6}
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.nameCn || s.name}</span>
                  {s.nameCn && (
                    <span className="block truncate text-xs text-on-surface-variant">{s.name}</span>
                  )}
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-base text-primary">
                    {s.score !== null ? s.score.toFixed(1) : "—"}
                  </span>
                  <span className="block text-xs text-on-surface-variant">
                    {s.ratingTotal !== null && s.ratingTotal > 0 ? `${s.ratingTotal} 人` : "暂无"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}

      {lastPage > 1 && (
        <nav className="flex items-center justify-between gap-3 text-sm" aria-label="分页">
          {page > 1 ? (
            <Link href={hrefFor({ page: page - 1 })} className="badge">
              上一页
            </Link>
          ) : (
            <span className="badge opacity-40" aria-disabled="true">
              上一页
            </span>
          )}
          <span className="text-on-surface-variant">
            第 {page} / {lastPage} 页（每页 {RANKING_PAGE_SIZE} 条）
          </span>
          {page < lastPage ? (
            <Link href={hrefFor({ page: page + 1 })} className="badge">
              下一页
            </Link>
          ) : (
            <span className="badge opacity-40" aria-disabled="true">
              下一页
            </span>
          )}
        </nav>
      )}
    </div>
  );
}
