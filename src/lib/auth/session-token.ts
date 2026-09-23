/**
 * 会话令牌的签发与校验 —— **不依赖任何 web 框架**。
 *
 * 与 `session.ts` 的分工：
 * - 本模块是纯 Node 逻辑（HMAC 签名），任何进程都能用
 * - `session.ts` 负责 Next.js 侧的 Cookie 读写（依赖 `next/headers`）
 *
 * 为什么必须拆开：弹幕网关是**独立常驻进程**，它要校验连接建立时的会话，
 * 但它是 WS 服务，没有 Next.js 的请求上下文 —— 从 `session.ts` 导入会把
 * `next/headers` 一起拖进来，既跑不通、也让网关无法被独立打包。
 *
 * 令牌只存 userId；其余信息每次回库读取，便于封禁/改校即时生效。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hitani_session";
/** OAuth state 参数（防 CSRF），随会话 Cookie 短期存放。 */
export const OAUTH_STATE_COOKIE = "hitani_oauth_state";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) throw new Error("缺少环境变量 SESSION_SECRET");
  return value;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function createSessionToken(userId: string, now = Date.now()): string {
  const expiresAt = now + MAX_AGE_SECONDS * 1000;
  const payload = `${userId}.${expiresAt}`;
  return `${payload}.${sign(payload)}`;
}

/** 校验并解出 userId；失败返回 null（不抛异常，调用方决定是否 401）。 */
export function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [userId, expiresAtRaw, signature] = parts;
  const payload = `${userId}.${expiresAtRaw}`;
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < now) return null;

  return userId;
}

/** 会话 Cookie 的有效期（秒），供 `Set-Cookie` 使用。 */
export const SESSION_MAX_AGE_SECONDS = MAX_AGE_SECONDS;

/** OAuth state 随机值。 */
export function generateOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * 从 Cookie 头解析键值对。
 *
 * WS 的 upgrade 请求拿不到 `next/headers`，只能自己解析 ——
 * 这也是网关需要本模块（而非 `session.ts`）的原因。
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

/** 从 Cookie 头直接解出 userId —— 网关用。 */
export function sessionUserIdFromCookieHeader(
  header: string | undefined,
  now = Date.now(),
): string | null {
  const cookies = parseCookieHeader(header);
  return verifySessionToken(cookies[SESSION_COOKIE], now);
}

/* ------------------------------------------------------------------ *
 * 管理员判定
 * ------------------------------------------------------------------ */

/**
 * 从 `ADMIN_EMAILS` 环境变量读取管理员邮箱清单（逗号分隔）。
 *
 * 用环境变量而非 DB 字段作为授予途径：部署时改一个环境变量就能加管理员，
 * 不需要连数据库手改。DB 里的 `isAdmin` 是快照，登录时按此清单同步。
 */
export function adminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.length > 0),
  );
}

/** 该邮箱是否为配置的管理员。 */
export function isConfiguredAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(email.toLowerCase());
}
