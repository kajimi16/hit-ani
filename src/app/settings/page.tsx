import Link from "next/link";
import { redirect } from "next/navigation";
import JellyfinManager from "@/components/jellyfin-manager";
import SettingsClient from "@/components/settings-client";
import { isBgmOAuthConfigured } from "@/lib/auth/bgm-oauth";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">账号设置</h1>
        <p className="text-sm text-neutral-400">
          {user.nickname} · {user.email ?? "无邮箱"} · 学校{" "}
          <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs">{user.schoolId}</span>
        </p>
      </section>

      <SettingsClient
        qqBound={user.qqBound}
        bgmBound={user.bgmBound}
        bgmUsername={user.bgmUsername}
        oauthConfigured={isBgmOAuthConfigured()}
      />

      <section className="space-y-3 border-t border-neutral-800 pt-8">
        <h2 className="text-lg font-semibold">我的媒体服务器</h2>
        <p className="text-sm text-neutral-400">
          连接你自己的 Jellyfin / Emby，就能在条目页直接播放媒体库里的内容。
          <strong className="text-neutral-300">
            视频由你的服务器直连播放器，不经过本平台。
          </strong>
        </p>
        <JellyfinManager />
      </section>

      <section className="text-sm">
        <Link href="/library" className="text-sky-400 underline">
          前往我的追番
        </Link>
      </section>
    </div>
  );
}
