"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  nickname: string;
  schoolId: string;
  isAdmin: boolean;
}

/** 顶部用户区：昵称 / 学校 / 登出。 */
export default function UserMenu({ nickname, schoolId, isAdmin }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", { method: "DELETE" });
      if (!response.ok) throw new Error("登出失败");
      // refresh 让服务端重新渲染导航（否则仍是登录态）
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span className="text-neutral-500">
        {nickname}
        <span className="ml-2 rounded bg-neutral-800 px-2 py-0.5 text-xs">{schoolId}</span>
        {isAdmin && (
          <span className="ml-1 rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-300">
            管理员
          </span>
        )}
      </span>
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        title={error ?? undefined}
        className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40"
      >
        {busy ? "登出中…" : "登出"}
      </button>
      {error && <span className="text-xs text-red-300">{error}</span>}
    </div>
  );
}
