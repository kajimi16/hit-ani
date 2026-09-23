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

      <div className="rounded border border-neutral-800 bg-neutral-900/40 p-4 text-xs text-neutral-400">
        <p className="font-medium text-neutral-300">校内准入</p>
        <p className="mt-1">只有下列学校邮箱域名的账号可以注册，学校归属由此确定：</p>
        <ul className="mt-2 space-y-1">
          {schools.map((school) => (
            <li key={school.id}>
              <span className="text-neutral-300">{school.name}</span>
              <span className="ml-2 font-mono">{school.domains.join("、")}</span>
            </li>
          ))}
          {schools.length === 0 && <li className="text-neutral-600">正在读取学校列表…</li>}
        </ul>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">学校邮箱</span>
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@hit.edu.cn"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-sky-500"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">昵称</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-sky-500"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">学号（可选）</span>
          <input
            value={studentNo}
            onChange={(event) => setStudentNo(event.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 outline-none focus:border-sky-500"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-neutral-400">密码（至少 8 位）</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
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
        {busy ? "注册中…" : "注册"}
      </button>

      <p className="text-center text-sm text-neutral-500">
        已有账号？
        <a href="/login" className="ml-1 text-sky-400 underline">
          登录
        </a>
      </p>
    </div>
  );
}
