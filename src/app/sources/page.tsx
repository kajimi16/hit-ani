import { redirect } from "next/navigation";
import JellyfinManager from "@/components/jellyfin-manager";
import SourceManager from "@/components/source-manager";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "媒体源 · hit-ani" };

export default async function SourcesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">媒体源与播放</h1>
        <p className="text-sm text-neutral-400">
          两种方式：<strong className="text-neutral-300">媒体服务器</strong>（推荐）
          —— 视频直连你自己的 Jellyfin，平台不传视频；
          <strong className="text-neutral-300">抓取源</strong>
          —— 只保存「去哪里找资源」的规则，不含视频文件、种子或直链。
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

      <section className="space-y-3 border-t border-neutral-800 pt-8">
        <JellyfinManager />
      </section>

      <section className="space-y-3 border-t border-neutral-800 pt-8">
        <h1 className="text-xl font-semibold">抓取源</h1>
        <SourceManager />
      </section>
    </div>
  );
}
