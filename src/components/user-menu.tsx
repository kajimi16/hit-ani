"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Image from "next/image";

interface Props {
  nickname: string;
  schoolId: string;
  isAdmin: boolean;
  /** 头像地址；null 时显示昵称首字占位。 */
  avatarUrl: string | null;
  /**
   * 收窄的侧边栏（<1200px）里放不下昵称，只留图标。
   *
   * 用 prop 而不是另写一个组件 —— 登出逻辑必须**只有一份**，
   * 否则某天改了接口路径就会出现「一边能登出一边不能」。
   */
  compact?: boolean;
}

/** 侧边栏底部的用户区：昵称 / 学校 / 管理员标识 / 登出。 */
export default function UserMenu({
  nickname,
  schoolId,
  isAdmin,
  avatarUrl,
  compact = false,
}: Props) {
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

  /** 昵称首字占位 —— 中文取首字，英文取首字母大写。 */
  const initial = ([...nickname.trim()][0] ?? "?").toUpperCase();
  const title = `${nickname} · ${schoolId}${isAdmin ? " · 管理员" : ""}`;

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1 px-1">
        {avatarUrl ? (
          <Image
            src={avatarUrl}
            alt=""
            width={64}
            height={64}
            sizes="32px"
            className="size-8 rounded-full object-cover"
            title={title}
          />
        ) : (
          <span
            className="flex size-8 items-center justify-center rounded-full bg-primary-container text-xs text-on-primary-container"
            title={title}
          >
            {initial}
          </span>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          disabled={busy}
          title={error ?? "登出"}
          className="text-[0.6875rem] text-on-surface-variant hover:text-on-surface"
        >
          {busy ? "…" : "登出"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-1">
      {/*
        用户信息做成一个整块：昵称 + 学校 + 管理员标识。
        原先散着排，视觉上是三个无关的碎片。
      */}
      <div className="flex flex-col gap-1.5 rounded-md bg-surface-container-high px-2.5 py-2">
        <span className="flex items-center gap-2">
          {avatarUrl ? (
            <Image
              src={avatarUrl}
              alt=""
              width={64}
              height={64}
              sizes="24px"
              className="size-6 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-container text-[0.625rem] text-on-primary-container"
            >
              {initial}
            </span>
          )}
          <span className="truncate text-sm text-on-surface" title={nickname}>
            {nickname}
          </span>
        </span>
        <span className="flex flex-wrap gap-1">
          <span className="badge">{schoolId}</span>
          {isAdmin && <span className="badge badge-accent">管理员</span>}
        </span>
      </div>

      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        title={error ?? undefined}
        className="btn btn-ghost btn-sm w-full"
      >
        {busy ? "登出中…" : "登出"}
      </button>

      {error && <p className="text-xs text-error">{error}</p>}
    </div>
  );
}
