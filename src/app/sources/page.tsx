import { redirect } from "next/navigation";
import SourceManager from "@/components/source-manager";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "媒体源 · hit-ani" };

export default async function SourcesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  // 抓取源是全站共享配置，只有管理员能看/改。
  // 用户自己的媒体服务器连接在「设置」页（个人配置）。
  if (!user.isAdmin) redirect("/settings");

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">抓取源（管理员）</h1>
        <p className="text-sm text-neutral-400">
          全站共享的「去哪里找资源」规则。只保存查找规则（URL 模板、CSS 选择器、正则），
          <strong className="text-neutral-300">不含视频文件、种子或直链</strong>。
        </p>
        <div className="rounded border border-amber-900/70 bg-amber-950/30 p-4 text-xs text-amber-200/90">
          <p className="font-medium">使用前请确认</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>资源的合法性由<b>部署方</b>负责，与平台代码无关。</li>
            <li>请只添加你有权访问的来源；不要把内网地址填进来（服务端会拒绝）。</li>
            <li>抓取会给对方站点带来负载，请求间隔有下限，请勿调得过低。</li>
          </ul>
        </div>
      </section>

      <SourceManager />
    </div>
  );
}
