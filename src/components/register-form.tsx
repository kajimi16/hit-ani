"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export interface SchoolOption {
  id: string;
  name: string;
  domains: string[];
}

interface Props {
  /** 学校白名单。由服务端组件取好传入 —— 首屏就有，不必客户端再拉一次。 */
  schools: SchoolOption[];
}

/**
 * 注册表单（客户端）。
 *
 * ## 为什么「邮件是否配置」不在这里判断
 *
 * 那个判断必须在**服务端**完成，否则首屏会先渲染出可填的表单、水合后才被
 * 替换成说明 —— 用户可能已经开始输入了。页面（`page.tsx`）是服务端组件，
 * 它直接调 `checkCapabilities()` 并决定渲染表单还是说明。
 */
export default function RegisterForm({ schools }: Props) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [studentNo, setStudentNo] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 发送验证码的独立状态 —— 与「注册」互不阻塞。 */
  const [sending, setSending] = useState(false);
  const [codeNotice, setCodeNotice] = useState<string | null>(null);
  /** 倒计时秒数。> 0 时禁用发送按钮，避免连点触发节流报错。 */
  const [cooldown, setCooldown] = useState(0);

  /*
   * 倒计时。用 `setInterval` 每秒减 1，到 0 清掉定时器 ——
   * 让「还要等多久」可见，比让用户连点然后吃 429 报错好得多。
   */
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const sendCode = async () => {
    setSending(true);
    setError(null);
    setCodeNotice(null);
    try {
      const response = await fetch("/api/auth/email/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await response.json()) as { error?: string; resendAfterMs?: number };
      if (!response.ok) {
        // 429 自带重试间隔 —— 直接进入倒计时，而不是让用户自己猜
        if (response.status === 429 && body.resendAfterMs) {
          setCooldown(Math.ceil(body.resendAfterMs / 1000));
        }
        throw new Error(body.error ?? "发送失败");
      }
      setCooldown(Math.ceil((body.resendAfterMs ?? 60_000) / 1000));
      setCodeNotice("验证码已发送，请查收邮件（若没收到，也看看垃圾邮件）。");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

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
          verificationCode: verificationCode.trim(),
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

      <div className="panel bg-surface-container text-xs text-on-surface-variant">
        <p className="font-medium text-on-surface">校内准入</p>
        <p className="mt-1">只有下列学校邮箱域名的账号可以注册，学校归属由此确定：</p>
        <ul className="mt-2 space-y-1">
          {schools.map((school) => (
            <li key={school.id}>
              <span className="text-on-surface">{school.name}</span>
              <span className="ml-2 font-mono">{school.domains.join("、")}</span>
            </li>
          ))}
          {schools.length === 0 && <li className="text-on-surface-variant/70">正在读取学校列表…</li>}
        </ul>
      </div>

      <div className="space-y-3">
        <label className="block space-y-1 text-sm">
          <span className="text-on-surface-variant">学校邮箱</span>
          <div className="flex gap-2">
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@hit.edu.cn"
              type="email"
              autoComplete="email"
              className="input flex-1"
            />
            <button
              type="button"
              onClick={() => void sendCode()}
              /* 邮箱为空或倒计时中都不该能点 —— 点了必然失败或吃 429 */
              disabled={sending || cooldown > 0 || email.trim().length === 0}
              className="btn btn-ghost shrink-0"
            >
              {sending ? "发送中…" : cooldown > 0 ? `${cooldown}s` : "发送验证码"}
            </button>
          </div>
        </label>

        <label className="block space-y-1 text-sm">
          <span className="text-on-surface-variant">邮箱验证码</span>
          <input
            value={verificationCode}
            onChange={(event) =>
              // 只留数字并截到 6 位 —— 邮件里常带空格，用户也常粘贴多字符
              setVerificationCode(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
            placeholder="6 位数字"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="input font-mono tracking-widest"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-on-surface-variant">昵称</span>
          <input
            value={nickname}
            onChange={(event) => setNickname(event.target.value)}
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-on-surface-variant">学号（可选）</span>
          <input
            value={studentNo}
            onChange={(event) => setStudentNo(event.target.value)}
            className="input"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-on-surface-variant">密码（至少 8 位）</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="input"
          />
        </label>
      </div>

      {codeNotice && <p className="alert alert-success text-sm">{codeNotice}</p>}

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

      <p className="text-center text-sm text-on-surface-variant/70">
        已有账号？
        <a href="/login" className="ml-1 text-primary underline">
          登录
        </a>
      </p>
    </div>
  );
}
