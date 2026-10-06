/**
 * 邮件发送 —— **可插拔传输层**。
 *
 * ## 为什么做成可插拔
 *
 * 「用哪个发信通道」在自建部署里没有统一答案：
 *
 * - **学校 SMTP**：最合规（发件人是校内域名），但要走申请流程；
 * - **Cloudflare 路线**：Cloudflare 官方**没有通用的事务性发信服务**
 *   （Email Routing 的 `send_email` 只能发到账户内已验证地址），
 *   实践中是通过它后面的 HTTP API（MailChannels / Resend / 自建 Worker）发。
 *
 * 两者的配置形状完全不同，但调用方只关心「把一封信发出去」。因此这里定义
 * 一个最小的 `EmailTransport` 接口，由环境变量选实现 —— 换通道只需改
 * `.env`，不必动代码。
 *
 * ## 未配置时怎么办
 *
 * `createTransport()` 返回 `null`，由调用方决定语义（注册流程会**拒绝**并
 * 说明原因，而不是假装发出去了）。这一点不能含糊：静默失败会让用户卡在
 * 「收不到验证码」且无从判断。
 */

import nodemailer from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  /** 纯文本正文。不用 HTML —— 验证码邮件不需要，且纯文本更不容易进垃圾箱。 */
  text: string;
}

export interface EmailTransport {
  /** 实现名，用于日志与错误提示。 */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** 发件人。多数 SMTP 服务要求它与认证账号一致，否则会被拒。 */
function fromAddress(): string {
  return process.env.EMAIL_FROM?.trim() || process.env.SMTP_USER?.trim() || "no-reply@localhost";
}

/**
 * SMTP 传输（nodemailer）。
 *
 * `SMTP_SECURE` 留空时按端口推断（465 用隐式 TLS，其余用 STARTTLS）——
 * 显式写死 `secure: true` 是常见错误：587 端口上它会让连接直接握手失败。
 */
function createSmtpTransport(): EmailTransport | null {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.SMTP_PORT ?? 587);
  const secureEnv = process.env.SMTP_SECURE?.trim();
  const secure = secureEnv ? secureEnv === "1" || secureEnv.toLowerCase() === "true" : port === 465;

  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure,
    // 未配认证时**不要**传 auth —— 传空对象会让部分服务器直接拒绝连接
    ...(user ? { auth: { user, pass } } : {}),
    // 发信必须有超时，否则上游卡住会拖死整个请求（注册接口在等它）
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return {
    name: `smtp:${host}:${port}${secure ? ":tls" : ""}`,
    async send(message) {
      await transporter.sendMail({
        from: fromAddress(),
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}

/**
 * HTTP API 传输。
 *
 * 适配最常见的形状（Resend / Postmark / MailChannels / 自建 Worker 都类似）：
 *
 * ```
 * POST {EMAIL_API_URL}
 * Authorization: Bearer {EMAIL_API_KEY}
 * { "from": "...", "to": "...", "subject": "...", "text": "..." }
 * ```
 *
 * 若某个服务商的字段名不同，在这里加一层字段映射即可 —— 不要为此去改调用方。
 */
function createHttpTransport(): EmailTransport | null {
  const url = process.env.EMAIL_API_URL?.trim();
  if (!url) return null;

  const key = process.env.EMAIL_API_KEY?.trim();

  return {
    name: `http:${new URL(url).host}`,
    async send(message) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          from: fromAddress(),
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`邮件 API 返回 ${response.status}：${detail.slice(0, 200)}`);
      }
    },
  };
}

/**
 * 按环境变量选择传输。
 *
 * 优先级：**SMTP 优先** —— 它更通用，且配了 SMTP 的人通常是有意为之。
 * 两者都没配时返回 `null`（**不抛错**）：调用方要能区分「没配置」与
 * 「配置了但发送失败」，前者是部署问题、后者是运维问题。
 */
export function createTransport(): EmailTransport | null {
  return createSmtpTransport() ?? createHttpTransport();
}

/** 邮件功能是否可用（注册页据此提示）。 */
export function isEmailConfigured(): boolean {
  return createTransport() !== null;
}
