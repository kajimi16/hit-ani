import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ReportsClient from "@/components/reports-client";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "举报处理" };

/**
 * 举报处理后台（仅管理员）。
 *
 * 非管理员**直接跳回首页**而不是显示 403 页面 —— 他们是从侧栏点进来的
 * （侧栏对本就不该显示这一项），给一个错误页没有意义。
 * 侧栏那一项也按 `isAdmin` 隐藏，两处一致。
 */
export default async function AdminReportsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.isAdmin) redirect("/");

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-normal">举报处理</h1>
        <p className="text-sm text-on-surface-variant">
          处理其他用户提交的弹幕举报。屏蔽后该弹幕在所有读路径上不可见，但仍保留在库里以便追溯。
        </p>
      </div>

      <ReportsClient />
    </div>
  );
}
