"use client";

import { useState } from "react";

interface Props {
  userId: string;
  initialFollowing: boolean;
}

/**
 * 关注 / 取消关注按钮。
 *
 * 这是「别人的追番页」上**唯一**的写操作 —— 它改的是「我与他的关系」，
 * 不是他的追番数据。只读性由这一点保证：页面上没有任何能改对方内容的路径。
 *
 * 乐观更新 + 失败回滚：关注是高频轻量操作，等一次往返再变色会显得迟钝。
 */
export default function FollowButton({ userId, initialFollowing }: Props) {
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !following;
    const previous = following;
    setFollowing(next);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/friends", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, action: next ? "follow" : "unfollow" }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "操作失败");
    } catch (e) {
      setFollowing(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-pressed={following}
        className={`btn ${following ? "btn-ghost" : "btn-primary"}`}
      >
        {busy ? "…" : following ? "已关注" : "加好友"}
      </button>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
