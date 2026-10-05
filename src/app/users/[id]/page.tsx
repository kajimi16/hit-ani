import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { LibraryGridCard, LibraryListRow } from "@/components/library-views";
import UserAvatar from "@/components/user-avatar";
import FollowButton from "@/components/follow-button";
import { getSessionUser } from "@/lib/auth/session";
import { COLLECTION_STATUSES, statusBySlug } from "@/lib/collection";
import { getUserProfile } from "@/lib/friends/repository";
import { loadLibrary, toLibraryItem } from "@/lib/library/service";
import { LIBRARY_PAGE_SIZE, LIBRARY_SORTS, LIBRARY_VIEWS, parseLibraryQuery } from "@/lib/library-query";

export const dynamic = "force-dynamic";

/**
 * 别人的追番列表（**只读**）。
 *
 * ## 只读是结构性保证，不是靠「不渲染按钮」
 *
 * 这一页复用的 `LibraryGridCard` / `LibraryListRow` 是**纯展示组件** ——
 * 它们只渲染 `next/link` 链接，没有任何 `onClick` / `fetch`。因此「不能修改」
 * 不依赖于这里少放几个控件，而是那些控件根本不存在于这条渲染路径上。
 *
 * 唯一的写操作是**关注按钮**，它改的是「我和他的关系」，不是他的追番数据。
 *
 * ## 隐私
 *
 * `loadLibrary` 在 `viewerId !== userId` 时会过滤掉 `isPrivate` 的收藏 ——
 * 那是用户在 BGM 上明确设为私密的内容。界面上会说明这一点，避免用户以为
 * 「对方收藏很少」。
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const viewer = await getSessionUser();
  const profile = await getUserProfile(viewer?.id ?? null, id).catch(() => null);
  return { title: profile ? `${profile.nickname} 的追番` : "用户" };
}

export default async function UserLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; sort?: string; view?: string; page?: string }>;
}) {
  const viewer = await getSessionUser();
  if (!viewer) redirect("/login");

  const { id } = await params;
  const profile = await getUserProfile(viewer.id, id);
  if (!profile) notFound();

  // 自己的页面直接跳回 /library —— 这里没有「我的」编辑能力，
  // 让用户停在一个功能更少的页面上没有意义。
  if (profile.isSelf) redirect("/library");

  const sp = await searchParams;
  const focused = statusBySlug(sp.status);
  const query = parseLibraryQuery(sp);

  const { rowsByType, countByType, watchedBySubject, totalForFocused, hidesPrivate } =
    await loadLibrary({ userId: id, viewerId: viewer.id, focused, query });

  const hrefFor = (overrides: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    const status = overrides.status ?? focused?.slug;
    if (status) search.set("status", status);
    const sort = overrides.sort ?? query.sort;
    if (sort !== "recent") search.set("sort", sort);
    const view = overrides.view ?? query.view;
    if (view !== "grid") search.set("view", view);
    const page = overrides.page;
    if (page && page !== "1") search.set("page", page);
    const qs = search.toString();
    return `/users/${id}${qs ? `?${qs}` : ""}`;
  };

  const totalPages = focused ? Math.max(1, Math.ceil(totalForFocused / LIBRARY_PAGE_SIZE)) : 1;
  const isList = query.view === "list";

  return (
    <div className="animate-rise space-y-6">
      {/* ---------------------------------------------------------- 头部 */}
      <section className="flex flex-wrap items-center gap-4">
        <UserAvatar url={profile.avatarUrl} nickname={profile.nickname} size={56} />
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-normal">
            {profile.nickname}
            <span className="badge">{profile.schoolId}</span>
          </h1>
          <p className="text-sm text-on-surface-variant">
            {profile.publicCollectionCount} 部公开追番
            {hidesPrivate && "（不含私密收藏）"}
          </p>
        </div>
        <div className="ml-auto">
          <FollowButton userId={profile.id} initialFollowing={profile.following} />
        </div>
      </section>

      <p className="text-xs text-on-surface-variant">
        这是只读视图，无法修改对方的追番。
      </p>

      {/* ---------------------------------------------------------- 状态筛选 */}
      <nav className="flex flex-wrap gap-2">
        <a
          href={hrefFor({ status: undefined, page: undefined })}
          aria-current={focused === null ? "page" : undefined}
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
              href={hrefFor({ status: meta.slug, page: undefined })}
              aria-current={active ? "page" : undefined}
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
              href={hrefFor({ sort: option.value, page: undefined })}
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
              href={hrefFor({ view: option.value, page: undefined })}
              aria-current={query.view === option.value ? "true" : undefined}
              className={`btn btn-sm ${query.view === option.value ? "btn-primary" : "btn-ghost"}`}
            >
              {option.label}
            </a>
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------- 列表 */}
      {(focused ? [focused] : COLLECTION_STATUSES).map((meta) => {
        const shown = rowsByType.get(meta.value) ?? [];
        const total = countByType.get(meta.value) ?? 0;
        if (total === 0) return null;

        return (
          <section key={meta.slug} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-3">
              <h2 className="text-lg font-medium">{meta.label}</h2>
              <span className="text-sm text-on-surface-variant">{total} 部</span>
            </div>

            {isList ? (
              <ul className="panel p-0">
                {shown.map((row) => (
                  <LibraryListRow
                    key={row.id}
                    item={toLibraryItem(row, watchedBySubject)}
                  />
                ))}
              </ul>
            ) : (
              <div className="subject-grid">
                {shown.map((row) => (
                  <LibraryGridCard
                    key={row.id}
                    item={toLibraryItem(row, watchedBySubject)}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {[...countByType.values()].every((n) => n === 0) && (
        <p className="panel text-sm text-on-surface-variant">
          {profile.nickname} 还没有公开的追番。
        </p>
      )}

      {focused && totalPages > 1 && (
        <nav className="flex items-center justify-center gap-2 pt-2">
          {query.page > 1 && (
            <a href={hrefFor({ page: String(query.page - 1) })} className="btn btn-ghost btn-sm">
              ← 上一页
            </a>
          )}
          <span className="px-3 font-mono text-xs text-on-surface-variant">
            {query.page} / {totalPages}
          </span>
          {query.page < totalPages && (
            <a href={hrefFor({ page: String(query.page + 1) })} className="btn btn-ghost btn-sm">
              下一页 →
            </a>
          )}
        </nav>
      )}

      <p className="text-xs text-on-surface-variant">
        想管理自己的追番？去
        <Link href="/library" className="mx-1 text-primary underline">
          我的追番
        </Link>
        。
      </p>
    </div>
  );
}
