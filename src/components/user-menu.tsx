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
    <div className="flex items-center gap-2">
      {/*
        用户信息做成一个整块：昵称 + 学校 + 管理员标识。
        原先散着排，视觉上是三个无关的碎片。
      */}
      <div className="flex items-center gap-2 rounded-md bg-surface-2 px-2.5 py-1.5">
        <span className="text-sm text-ink">{nickname}</span>
        <span className="badge">{schoolId}</span>
        {isAdmin && <span className="badge badge-accent">管理员</span>}
      </div>

      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        title={error ?? undefined}
        className="btn btn-ghost btn-sm"
      >
        {busy ? "登出中…" : "登出"}
      </button>

      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
