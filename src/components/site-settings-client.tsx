"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  /** 服务端已渲染过的初始值。 */
  initialNsfwEnabled: boolean;
}

/**
 * 网站管理 —— NSFW（R18）内容总开关。
 *
 * ## 这是**站点级**，不是用户偏好
 *
 * 用户自己那台设备的「显示 / 不显示」偏好仍在设置页（cookie）。这里是管理员
 * 决定本部署**是否允许**出现这类内容：
 *
 * - 关闭：探索页与时间表一律不请求 R18 条目，普通用户的设置里也不再出现该项；
 * - 打开：恢复为用户自己选择（默认仍是「不显示」）。
 *
 * ## 为什么关掉后要把用户那个选项藏起来
 *
 * 留着一个「显示」按钮、点了却什么也不会变，比没有这个按钮更糟 ——
 * 用户会以为功能坏了，或者以为自己被骗了。所以是**不渲染**，不是禁用。
 */
export default function SiteSettingsClient({ initialNsfwEnabled }: Props) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialNsfwEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !enabled;
    const previous = enabled;
    // 乐观更新：失败时回滚，避免按钮在慢网络下"点了没反应"
    setEnabled(next);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/site", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nsfwEnabled: next }),
      });
      const body = (await response.json()) as { error?: string; nsfwEnabled?: boolean };
      if (!response.ok) throw new Error(body.error ?? "保存失败");

      // 以**服务端回写的值**为准，而不是本地推出来的 next
      if (typeof body.nsfwEnabled === "boolean") setEnabled(body.nsfwEnabled);
      // 全站页面的渲染都取决于这个开关，刷新一次让服务端重新取数
      router.refresh();
    } catch (e) {
      setEnabled(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel space-y-3 p-5">
      <h2 className="font-medium">R18 / NSFW 内容</h2>
      <p className="text-sm text-on-surface-variant">
        {enabled
          ? "允许出现 R18 条目。每个用户仍可在自己的设置里选择是否显示（默认不显示）。"
          : "探索页与时间表不再请求 R18 条目；排行榜、追番、时光机与条目页会排除已标记为 R18 的内容；普通用户的设置里也不再出现该选项。"}
      </p>

      {/*
        **如实写明边界**，避免管理员以为「关了就等于全站干净」。

        本地 `Subject` 表没有 nsfw 字段：探索页/时间表是按 BGM 的 `nsfw`
        过滤**根本不请求**它们，所以这条路径是可靠的；但用户通过「导入收藏」
        落进本地的条目无法回溯判定 —— 实测 Bangumi 的 `nsfw` 过滤对无权限的
        访问会被**静默忽略**（带 `nsfw: true` 搜索返回的全是 `nsfw: false`），
        因此历史条目里哪些是 R18，我们现在读不出来。
      */}
      <p className="text-xs text-on-surface-variant/70">
        说明：R18 标记来自 Bangumi，<strong>需要账号权限才能读取</strong>（登录且注册满 60 天）。
        尚未补全标记的条目无法判断，执行 <code>npm run nsfw:backfill</code> 可补全。
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="允许显示 R18 / NSFW 内容"
          onClick={() => void toggle()}
          disabled={busy}
          className={`btn ${enabled ? "btn-primary" : "btn-ghost"}`}
        >
          {busy ? "保存中…" : enabled ? "已开启（点击关闭）" : "已关闭（点击开启）"}
        </button>
        <span className="text-xs text-on-surface-variant/70">
          当前：{enabled ? "允许显示" : "全站隐藏"}
        </span>
      </div>

      {error && <p className="alert alert-warn text-xs">{error}</p>}
    </section>
  );
}
