"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import UserAvatar from "@/components/user-avatar";

export interface UserSummaryItem {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  schoolId: string;
  publicCollectionCount: number;
  following: boolean;
}

/** 一行用户：头像 + 昵称 + 追番数 + 关注按钮 + 查看追番入口。 */
function UserRow({
  user,
  onToggle,
  busy,
  selfId,
}: {
  user: UserSummaryItem;
  onToggle: (user: UserSummaryItem) => void;
  busy: boolean;
  selfId: string;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-outline-variant py-2.5 last:border-b-0">
      <UserAvatar url={user.avatarUrl} nickname={user.nickname} size={32} />

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm">
          <Link
            href={`/users/${user.id}`}
            className="truncate text-on-surface hover:text-primary hover:underline"
          >
            {user.nickname}
          </Link>
          <span className="badge shrink-0">{user.schoolId}</span>
          {user.id === selfId && <span className="text-xs text-on-surface-variant">（你）</span>}
        </p>
        <p className="text-xs text-on-surface-variant">
          {user.publicCollectionCount} 部公开追番
        </p>
      </div>

      <div className="flex shrink-0 gap-2">
        <Link href={`/users/${user.id}`} className="btn btn-ghost btn-sm">
          查看追番
        </Link>
        {/*
          自己的行不给关注按钮 —— 后端会拒绝（不能关注自己），
          但把它显示成一个必然失败的按钮更糟。
        */}
        {user.id !== selfId && (
          <button
            type="button"
            onClick={() => onToggle(user)}
            disabled={busy}
            className={`btn btn-sm ${user.following ? "btn-ghost" : "btn-primary"}`}
          >
            {busy ? "…" : user.following ? "已关注" : "加好友"}
          </button>
        )}
      </div>
    </li>
  );
}

interface Props {
  selfId: string;
  initialFollowing: UserSummaryItem[];
  initialFollowers: UserSummaryItem[];
}

/**
 * 好友页。
 *
 * ## 为什么是「单向关注」
 *
 * 双向好友需要「申请 → 同意」，而本平台**没有通知系统** —— 申请只能靠
 * 对方自己进这一页才发现，实际会被长期搁置。单向关注没有这个死角：
 * 加了立刻能看，对方在「关注我的人」里能看到谁加了他。
 *
 * ## 数据一次取全
 *
 * 三块（搜索 / 我关注的 / 关注我的）来自同一个接口 —— 它们在同一屏渲染，
 * 分开请求只会多两次往返。搜索用 `q` 参数触发服务端查询。
 */
export default function FriendsClient({ selfId, initialFollowing, initialFollowers }: Props) {
  const [following, setFollowing] = useState(initialFollowing);
  const [followers] = useState(initialFollowers);
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<UserSummaryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    try {
      const response = await fetch(`/api/friends?q=${encodeURIComponent(q.trim())}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as { results?: UserSummaryItem[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "搜索失败");
      setResults(body.results ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, []);

  // 输入停顿 400ms 再搜 —— 每敲一个字都打接口没有必要，也更容易触发限流
  useEffect(() => {
    const timer = window.setTimeout(() => void search(keyword), 400);
    return () => window.clearTimeout(timer);
  }, [keyword, search]);

  const toggle = async (user: UserSummaryItem) => {
    setBusyId(user.id);
    setError(null);
    const nextFollowing = !user.following;
    try {
      const response = await fetch("/api/friends", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, action: nextFollowing ? "follow" : "unfollow" }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "操作失败");

      /*
       * 只改本地状态，不整页刷新 —— 搜索框里的内容与滚动位置都是用户
       * 刚建立的上下文，`router.refresh()` 会把它们清掉。
       */
      // 搜索结果里的那一行只需换按钮文案
      setResults((list) =>
        list.map((item) => (item.id === user.id ? { ...item, following: nextFollowing } : item)),
      );

      // 「我的好友」列表要**增删**，不是改文案：
      //  - 关注 → 若还不在列表里才插到最前（已在列表里就什么都不做，避免重复）
      //  - 取消 → 从列表里移除
      setFollowing((list) => {
        if (!nextFollowing) return list.filter((item) => item.id !== user.id);
        if (list.some((item) => item.id === user.id)) return list;
        return [{ ...user, following: true }, ...list];
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="animate-rise space-y-6">
      {/* ---------------------------------------------------------- 搜索 */}
      <section className="space-y-2">
        <label htmlFor="friend-search" className="text-sm text-on-surface-variant">
          按昵称或学号找人
        </label>
        <input
          id="friend-search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入昵称或学号"
          autoComplete="off"
          className="input"
        />
        {searching && <p className="text-xs text-on-surface-variant">搜索中…</p>}
        {keyword.trim() && !searching && results.length === 0 && (
          <p className="text-xs text-on-surface-variant">没有找到匹配的用户。</p>
        )}
        {results.length > 0 && (
          <ul className="panel p-0 px-3">
            {results.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                selfId={selfId}
                busy={busyId === user.id}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </section>

      {error && <p className="alert alert-danger text-sm">{error}</p>}

      {/* ---------------------------------------------------------- 我关注的 */}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">
          我的好友
          <span className="ml-2 text-sm font-normal text-on-surface-variant">
            {following.length}
          </span>
        </h2>
        {following.length === 0 ? (
          <p className="panel text-sm text-on-surface-variant">
            还没有好友。上面搜一个人加为好友，就能看到他的追番列表。
          </p>
        ) : (
          <ul className="panel p-0 px-3">
            {following.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                selfId={selfId}
                busy={busyId === user.id}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------- 关注我的 */}
      <section className="space-y-2">
        <h2 className="text-lg font-medium">
          关注我的人
          <span className="ml-2 text-sm font-normal text-on-surface-variant">
            {followers.length}
          </span>
        </h2>
        {followers.length === 0 ? (
          <p className="panel text-sm text-on-surface-variant">还没有人关注你。</p>
        ) : (
          <ul className="panel p-0 px-3">
            {followers.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                selfId={selfId}
                busy={busyId === user.id}
                onToggle={toggle}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
