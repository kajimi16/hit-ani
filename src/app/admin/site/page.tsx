import type { Metadata } from "next";
import { redirect } from "next/navigation";
import SiteSettingsClient from "@/components/site-settings-client";
import { getSessionUser } from "@/lib/auth/session";
import { getSiteNsfwEnabled } from "@/lib/site-settings";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "网站管理" };

/**
 * 网站管理（仅管理员）。
 *
 * ## 与「账号设置」的分界
 *
 * `/settings` 里的是**每个用户自己的**选择；这里的是**这套部署**的策略。
 * 两者混在一个页面上，用户会分不清「我关掉了」和「网站关掉了」——
 * 而这两件事的后果完全不同（前者只影响这台设备，后者影响所有人）。
 *
 * 非管理员直接跳回首页：他们是从侧栏点进来的，而侧栏本来就不该显示这一项，
 * 给一个 403 页面没有意义（与 `/admin/reports` 一致）。
 */
export default async function AdminSitePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) redirect("/");

  const nsfwEnabled = await getSiteNsfwEnabled();

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-normal">网站管理</h1>
        <p className="text-sm text-on-surface-variant">
          这里的开关作用于
          <strong className="text-on-surface">整站所有用户</strong>
          ，改完立即生效。与「账号设置」里那些只影响你
          自己设备的选项不同。
        </p>
      </div>

      <SiteSettingsClient initialNsfwEnabled={nsfwEnabled} />
    </div>
  );
}
