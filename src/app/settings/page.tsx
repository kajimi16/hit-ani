import Link from "next/link";
import { redirect } from "next/navigation";
import JellyfinManager from "@/components/jellyfin-manager";
import OAuthNoticeBanner from "@/components/oauth-notice-banner";
import SettingsClient from "@/components/settings-client";
import ThemePicker from "@/components/theme-picker";
import { isBgmOAuthConfigured } from "@/lib/auth/bgm-oauth";
import { describeOAuthResult } from "@/lib/auth/oauth-result";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ bgm?: string; qq?: string; reason?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  /*
   * OAuth 回调是**整页跳转**回来的，结果只能放在 URL 里。此前这里根本没读
   * `searchParams`，于是回调写进去的 `bgm=ok|failed|taken|denied` 与 `reason`
   * **没有任何消费者** —— 用户被重定向回设置页，看不到任何反馈，只觉得刚才
   * 那一下「没反应」。绑定失败尤其糟：是本站拒绝了他，界面上却一个字都没有。
   */
  const oauthNotice = describeOAuthResult(await searchParams);

  return (
    <div className="space-y-8">
      {/*
        绑定回调的结果提示。此前回调参数没有任何消费者，用户被重定向回来
        后看不到任何反馈 —— 详见 `@/lib/auth/oauth-result`。
      */}
      {oauthNotice && <OAuthNoticeBanner notice={oauthNotice} />}

      <section className="space-y-2">
        <h1 className="text-2xl font-semibold">账号设置</h1>
        <p className="text-sm text-on-surface-variant">
          {user.nickname} · {user.email ?? "无邮箱"} · 学校{" "}
          <span className="rounded bg-surface-container-high px-2 py-0.5 text-xs">{user.schoolId}</span>
        </p>
      </section>

      {/* 外观是设备级偏好，与账号无关，因此放在最前 */}
      <ThemePicker />

      <SettingsClient
        qqBound={user.qqBound}
        bgmBound={user.bgmBound}
        bgmUsername={user.bgmUsername}
        oauthConfigured={isBgmOAuthConfigured()}
      />

      <section className="space-y-3 border-t border-outline-variant pt-8">
        <h2 className="text-lg font-semibold">我的媒体服务器</h2>
        <p className="text-sm text-on-surface-variant">
          连接你自己的 Jellyfin / Emby，就能在条目页直接播放媒体库里的内容。
          <strong className="text-on-surface">
            视频由你的服务器直连播放器，不经过本平台。
          </strong>
        </p>
        <JellyfinManager />
      </section>

      <section className="text-sm">
        <Link href="/library" className="text-primary underline">
          前往我的追番
        </Link>
      </section>
    </div>
  );
}
