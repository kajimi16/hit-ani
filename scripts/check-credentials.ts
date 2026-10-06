/**
 * 凭据自检 —— 部署**之前**跑，避免「部署完才发现配错」。
 *
 * 用法：
 *   npx tsx scripts/check-credentials.ts              # 只检查配置是否齐全
 *   npx tsx scripts/check-credentials.ts --send a@b.c # 真发一封测试邮件
 *   npx tsx scripts/check-credentials.ts --bgm        # 顺便验证 BGM 应用凭据
 *
 * ## 为什么值得单独写一个脚本
 *
 * 这两个凭据的失败方式都很隐蔽：
 *
 * - **SMTP**：配置写错（端口/加密方式）只有真正连一次才知道。`SMTP_SECURE`
 *   填错尤其典型 —— 587 端口上写 `secure=true` 会直接握手失败，而报错信息
 *   是一句含糊的 `wrong version number`。
 * - **BGM OAuth**：`client_id` / `client_secret` 错与 `redirect_uri` 与登记值
 *   不一致，在授权页上**表现得完全一样**（都是「出错了」）。但 BGM 的 token
 *   端点能区分它们：
 *     - `invalid_client` → 凭据本身不对；
 *     - `invalid_grant`  → 凭据**是对的**，只是我们给的是假 code。
 *   因此用一个假 code 打一次就能验证凭据 —— 不必真的走完授权流程。
 */

import nodemailer from "nodemailer";
import { createTransport, isEmailConfigured } from "../src/lib/email/transport";

const args = process.argv.slice(2);
const sendTo = args.includes("--send") ? args[args.indexOf("--send") + 1] : null;
const shouldCheckBgm = args.includes("--bgm");

/** 输出一行结果。`ok=false` 时用醒目前缀，便于扫读。 */
function report(ok: boolean, label: string, detail?: string): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ------------------------------------------------------------------ *
 * 邮件
 * ------------------------------------------------------------------ */

async function checkEmail(): Promise<boolean> {
  console.log("\n[邮件发送]");

  if (!isEmailConfigured()) {
    report(false, "未配置", "需要 SMTP_HOST 或 EMAIL_API_URL 之一");
    return false;
  }

  const transport = createTransport();
  if (!transport) return false;
  report(true, `传输：${transport.name}`);

  // SMTP 可以真正「握手 + 认证」一次来验证；HTTP 只能靠实际发送
  const isSmtp = transport.name.startsWith("smtp:");
  if (isSmtp) {
    try {
      // 直接构造一个验证用的连接，而不是走 transport 的 send
      const port = Number(process.env.SMTP_PORT ?? 587);
      const secureEnv = process.env.SMTP_SECURE?.trim();
      const secure = secureEnv
        ? secureEnv === "1" || secureEnv.toLowerCase() === "true"
        : port === 465;
      const user = process.env.SMTP_USER?.trim();

      const verifier = nodemailer.createTransport({
        host: process.env.SMTP_HOST!.trim(),
        port,
        secure,
        ...(user ? { auth: { user, pass: process.env.SMTP_PASS?.trim() } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
      });
      await verifier.verify();
      report(true, `SMTP 连接与认证通过（${process.env.SMTP_HOST}:${port}，${secure ? "隐式 TLS" : "STARTTLS"}）`);
    } catch (error) {
      report(false, "SMTP 连接或认证失败", error instanceof Error ? error.message : String(error));
      console.log(
        "     常见原因：SMTP_SECURE 填错（587 应为空或 0，465 才用 1）、" +
          "授权码而非登录密码、或服务商要求先开启 SMTP。",
      );
      return false;
    }
  }

  if (sendTo) {
    try {
      await transport.send({
        to: sendTo,
        subject: "hit-ani 凭据自检",
        text: "这是一封由 check-credentials.ts 发出的测试邮件。收到即表示配置正确。",
      });
      report(true, `测试邮件已发送到 ${sendTo}`);
    } catch (error) {
      report(false, "发送测试邮件失败", error instanceof Error ? error.message : String(error));
      return false;
    }
  } else {
    console.log("     （加 --send you@example.com 可以真发一封验证）");
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * BGM OAuth
 * ------------------------------------------------------------------ */

async function checkBgm(): Promise<boolean> {
  console.log("\n[Bangumi OAuth]");

  const id = process.env.BGM_CLIENT_ID?.trim();
  const secret = process.env.BGM_CLIENT_SECRET?.trim();
  const redirect = process.env.BGM_REDIRECT_URI?.trim();

  if (!id && !secret) {
    report(false, "未配置", "缺 BGM_CLIENT_ID / BGM_CLIENT_SECRET —— 未配置时设置页会禁用 OAuth 按钮");
    return false;
  }
  if (!id) {
    report(false, "缺 BGM_CLIENT_ID", "只填了 secret");
    return false;
  }
  if (!secret) {
    report(false, "缺 BGM_CLIENT_SECRET", "只填了 id");
    return false;
  }
  report(true, `client_id 与 client_secret 都已填写（长度 ${id.length} / ${secret.length}）`);

  if (!redirect) {
    report(
      false,
      "BGM_REDIRECT_URI 未设置",
      "会按访问者 host 推导 —— 用局域网 IP 打开时就与 BGM 登记值不符。必须写死。",
    );
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(redirect);
  } catch {
    report(false, "BGM_REDIRECT_URI 不是合法 URL", redirect);
    return false;
  }
  report(true, `redirect_uri = ${parsed.origin}${parsed.pathname}`);

  /*
   * 真凭据验证：用一个**假 code** 打 token 端点。
   *
   * BGM 能区分两种失败：
   *   invalid_client → client_id/secret 不对（**这是我们要抓的**）
   *   invalid_grant  → 凭据正确，只是 code 是假的（**期望结果**）
   * 所以看到 invalid_grant 就说明凭据没问题，不必真的走完授权流程。
   */
  try {
    const response = await fetch("https://bgm.tv/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: id,
        client_secret: secret,
        code: "deliberately-invalid-code",
        redirect_uri: redirect,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      error_description?: string;
    };

    if (body.error === "invalid_grant") {
      report(true, "BGM 确认凭据有效", "（返回 invalid_grant 是预期的 —— 我们给的是假 code）");
      return true;
    }
    if (body.error === "invalid_client" || body.error === "unauthorized_client") {
      report(false, "BGM 认为 client_id / client_secret 无效", body.error_description ?? body.error);
      return false;
    }
    report(
      body.error ? false : true,
      `token 端点返回 ${response.status}`,
      body.error ? `${body.error}：${body.error_description ?? ""}` : "未识别为 invalid_grant，请人工确认",
    );
    return !body.error;
  } catch (error) {
    report(false, "无法访问 bgm.tv", error instanceof Error ? error.message : String(error));
    console.log("     若在容器内运行，注意需要出站代理（见 docker-compose.yml 的 HTTP_PROXY）。");
    return false;
  }
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log("凭据自检（不会修改任何数据）");

  const emailOk = await checkEmail();
  const bgmOk = shouldCheckBgm ? await checkBgm() : null;

  console.log("\n结论：");
  report(emailOk, emailOk ? "注册功能可用" : "注册功能**不可用**（验证码发不出去）");
  if (bgmOk !== null) {
    report(
      bgmOk,
      bgmOk ? "Bangumi OAuth 可用" : "Bangumi OAuth 不可用（仍可用「个人访问令牌」）",
    );
  }
  if (!shouldCheckBgm) console.log("     （加 --bgm 一并检查 Bangumi OAuth 凭据）");

  process.exitCode = emailOk ? 0 : 1;
}

void main();
