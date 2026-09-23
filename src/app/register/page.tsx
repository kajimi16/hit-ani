"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface SchoolOption {
  id: string;
  name: string;
  domains: string[];
}

export default function RegisterPage() {
  const router = useRouter();
  const [schools, setSchools] = useState<SchoolOption[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [studentNo, setStudentNo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/register", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ schools: SchoolOption[] }>)
      .then((body) => setSchools(body.schools ?? []))
      .catch(() => setSchools([]));
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          password,
          nickname,
          studentNo: studentNo.trim() || undefined,
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "注册失败");
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
      <h1 className="text-2xl font-semibold">注册</h1>

      <div className="panel bg-surface-2 text-xs text-ink-muted">
        <p className="font-medium text-ink">校内准入</p>
        <p className="mt-1">只有下列学校邮箱域名的账号可以注册，学校归属由此确定：</p>
        <ul className="mt-2 space-y-1">
          {schools.map((school) => (
            <li key={school.id}>
              <span className="text-ink">{school.name}</span>
              <span className="ml-2 font-mono">{school.domains.join("、")}</span>
            </li>
          ))}
          {schools.length === 0 && <li className="text-ink-faint">正在读取学校列表…</li>}
        </ul>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">学校邮箱</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@hit.edu.cn"
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">昵称</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">学号（可选）</span>
          <input
            value={studentNo}
            onChange={(event) => setStudentNo(event.target.value)}
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">密码（至少 8 位）</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
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
        {busy ? "注册中…" : "注册"}
      </button>

      <p className="text-center text-sm text-ink-faint">
        已有账号？
        <a href="/login" className="ml-1 text-accent underline">
          登录
        </a>
      </p>
    </div>
  );
}
