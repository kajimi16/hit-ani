"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Step = "request" | "reset";

/**
 * 忘记密码 —— 两步式。
 *
 * ## 为什么之前会「永久失去账号」
 *
 * 此前全仓没有任何找回口令的入口：学生忘了口令只能找管理员改库。
 * 而登录是本站唯一的身份入口，这条路的断点代价很高。
 *
 * ## 两步而不是一步
 *
 * 先发码、再设新口令。中间那一步是**必需的**：只有拿到码才能证明这个
 * 邮箱属于请求者，否则任何人都能改任意账号的口令。
 */
export default function ForgotPasswordForm() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  // 倒计时 —— 让「还要等多久」可见，比让用户连点然后吃 429 好
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/email/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, purpose: "reset" }),
      });
      const body = (await response.json()) as { error?: string; resendAfterMs?: number };
      if (!response.ok) {
        // 429 自带重试间隔 —— 直接进入倒计时，不让用户自己猜
        if (response.status === 429 && body.resendAfterMs) {
          setCooldown(Math.ceil(body.resendAfterMs / 1000));
        }
        throw new Error(body.error ?? "发送失败");
      }
      setCooldown(Math.ceil((body.resendAfterMs ?? 60_000) / 1000));
      setNotice("重置验证码已发送。请注意：如果收到了多封，只有最新那一封有效。");
      setStep("reset");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitReset = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: code.trim(), password }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "重置失败");

      // 重置成功 → 跳登录页让用户用**新口令**登一次（不自动登录）
      router.push("/login?reset=ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {notice && <p className="alert alert-success text-sm">{notice}</p>}
      {error && <p className="alert alert-danger text-sm">{error}</p>}

      <label className="block space-y-1 text-sm">
        <span className="text-on-surface-variant">学校邮箱</span>
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@hit.edu.cn"
            autoComplete="email"
            className="input flex-1"
          />
          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={busy || cooldown > 0 || email.trim().length === 0}
            className="btn btn-ghost shrink-0"
          >
            {busy && step === "request" ? "发送中…" : cooldown > 0 ? `${cooldown}s` : "发送验证码"}
          </button>
        </div>
      </label>

      {step === "reset" && (
        <>
          <label className="block space-y-1 text-sm">
            <span className="text-on-surface-variant">邮箱验证码</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="6 位数字"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="input font-mono tracking-widest"
            />
          </label>

          <label className="block space-y-1 text-sm">
            <span className="text-on-surface-variant">新密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="至少 8 位"
              autoComplete="new-password"
              className="input"
            />
          </label>

          <button
            type="button"
            onClick={() => void submitReset()}
            disabled={busy || code.length !== 6 || password.length < 8}
            className="btn btn-primary w-full"
          >
            {busy ? "重置中…" : "重置密码"}
          </button>

          <p className="text-xs text-on-surface-variant">
            重置后不会自动登录 —— 请用新密码登录一次。
          </p>
        </>
      )}

      <p className="text-center text-sm text-on-surface-variant/70">
        <Link href="/login" className="text-primary underline">
          想起密码了，去登录
        </Link>
        <span className="mx-2 text-outline">·</span>
        <Link href="/register" className="text-primary underline">
          还没账号，去注册
        </Link>
      </p>
    </div>
  );
}
