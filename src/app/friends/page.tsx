import type { Metadata } from "next";
import { redirect } from "next/navigation";
import FriendsClient from "@/components/friends-client";
import { getSessionUser } from "@/lib/auth/session";
import { listFollowers, listFollowing } from "@/lib/friends/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "好友" };

/**
 * 好友页。
 *
 * 「单向关注」模型 —— 关注即可看对方的追番列表，不需要对方同意。
 * 理由见 `@/lib/friends/repository` 的说明（本平台没有通知系统，
 * 「申请 → 同意」的申请会被长期搁置）。
 */
export default async function FriendsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [following, followers] = await Promise.all([
    listFollowing(user.id),
    listFollowers(user.id),
  ]);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-normal">好友</h1>
        <p className="text-sm text-on-surface-variant">
          加好友后可以看到对方的追番列表（只读，不能修改）。
          对方设为私密的收藏不会显示。
        </p>
      </div>

      <FriendsClient
        selfId={user.id}
        initialFollowing={following}
        initialFollowers={followers}
      />
    </div>
  );
}
