import Link from "next/link";
import { redirect } from "next/navigation";
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

      <section className="text-sm">
        <Link href="/library" className="text-sky-400 underline">
          前往我的追番
        </Link>
      </section>
    </div>
  );
}
