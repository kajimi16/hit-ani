"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import UserAvatar from "@/components/user-avatar";

interface Props {
  /** 当前头像地址；null 表示用首字母占位。 */
  currentUrl: string | null;
  nickname: string;
  /** 已绑定 Bangumi 才提供「导入」；未绑定时不显示那个按钮。 */
  bgmBound: boolean;
}

/**
 * 头像设置。
 *
 * 三种来源（用 BGM 头像 / 自己贴链接 / 恢复默认）走同一个接口，
 * 而不是各开一个端点 —— 它们写的是同一列，分开写迟早出现「一个端点校验了
 * 协议、另一个没校验」。
 */
export default function AvatarSetting({ currentUrl, nickname, bgmBound }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "import" | "set" | "clear">(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const call = async (payload: Record<string, unknown>, kind: "import" | "set" | "clear") => {
    setBusy(kind);
    setError(null);
    try {
      const response = await fetch("/api/auth/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "设置失败");
      setDraft("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel space-y-4 p-5">
      <h2 className="font-medium">头像</h2>

      <div className="flex flex-wrap items-center gap-4">
        <UserAvatar url={currentUrl} nickname={nickname} size={64} />

        <div className="flex flex-wrap gap-2">
          {bgmBound && (
            <button
              type="button"
              onClick={() => void call({ action: "import-bgm" }, "import")}
              disabled={busy !== null}
              className="btn btn-primary btn-sm"
            >
              {busy === "import" ? "导入中…" : "使用 Bangumi 头像"}
            </button>
          )}
          {currentUrl && (
            <button
              type="button"
              onClick={() => void call({ action: "clear" }, "clear")}
              disabled={busy !== null}
              className="btn btn-ghost btn-sm"
            >
              {busy === "clear" ? "清除中…" : "恢复默认"}
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="avatar-url" className="text-xs text-on-surface-variant">
          或者贴一个图片直链（仅支持 https）
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="avatar-url"
            type="url"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="https://example.com/avatar.png"
            autoComplete="off"
            className="input min-w-64 flex-1 font-mono text-xs"
          />
          <button
            type="button"
            onClick={() => void call({ action: "set", url: draft.trim() }, "set")}
            disabled={busy !== null || draft.trim().length === 0}
            className="btn btn-ghost btn-sm"
          >
            {busy === "set" ? "保存中…" : "保存"}
          </button>
        </div>
        <p className="text-xs text-on-surface-variant">
          {bgmBound
            ? "导入会读取你 Bangumi 账号的头像。也可以贴任意 https 图片直链。"
            : "贴一个 https 图片直链即可。绑定 Bangumi 后还能一键导入它的头像。"}
        </p>
      </div>

      {error && <p className="alert alert-danger text-sm">{error}</p>}
    </section>
  );
}
