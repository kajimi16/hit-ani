"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "登录失败");
      router.push("/settings");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm space-y-6">
      <h1 className="text-2xl font-semibold">登录</h1>

      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">邮箱或学号</span>
          <input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-sky-500"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-sky-500"
          />
        </label>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="w-full rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {busy ? "登录中…" : "登录"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        没有账号？
        <a href="/register" className="ml-1 text-sky-400 underline">
          注册
        </a>
      </p>
    </div>
  );
}
