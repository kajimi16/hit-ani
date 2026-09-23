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
          <span className="text-ink-muted">邮箱或学号</span>
          <input
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">密码</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
            }}
            className="input"
          />
        </label>
      </div>

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="btn btn-primary w-full"
      >
        {busy ? "登录中…" : "登录"}
      </button>

      <p className="text-center text-sm text-ink-faint">
        没有账号？
        <a href="/register" className="ml-1 text-accent underline">
          注册
        </a>
      </p>
    </div>
  );
}
