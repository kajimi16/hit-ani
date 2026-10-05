/**
 * 会话层（Next.js 侧）：Cookie 读写与会话用户解析。
 *
 * 纯令牌逻辑在 `session-token.ts` —— 那个模块不依赖 web 框架，
 * 因此弹幕网关（独立常驻进程，没有 Next.js 请求上下文）也能复用。
 *
 * 会话只保存 `userId`，其余信息每次请求回库读取 —— 便于封禁/改校后即时生效。
 * 学校维度（`schoolId`）是本校弹幕/评论筛选的根基，因此绝不由客户端传递，
 * 一律从会话 → 数据库读取。
 */

import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resolveSecureCookie } from "./cookie-policy";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isConfiguredAdmin,
  verifySessionToken,
} from "./session-token";

// 纯逻辑从这里转发，保持既有导入路径可用（避免大范围改调用方）
export {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  adminEmails,
  createSessionToken,
  generateOAuthState,
  isConfiguredAdmin,
  parseCookieHeader,
  sessionUserIdFromCookieHeader,
  verifySessionToken,
} from "./session-token";

export interface SessionUser {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  schoolId: string;
  email: string | null;
  studentNo: string | null;
  qqBound: boolean;
  bgmBound: boolean;
  bgmUsername: string | null;
  /** 是否已连接至少一台 Jellyfin/Emby —— 决定条目页是否显示播放面板。 */
  jellyfinConnected: boolean;
  /** 管理员：可修改共享的抓取源配置。 */
  isAdmin: boolean;
}

/** 读取当前会话用户；未登录返回 null。 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const userId = verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      nickname: true,
      avatarUrl: true,
      schoolId: true,
      email: true,
      studentNo: true,
      qqBinding: { select: { userId: true } },
      bgmBinding: { select: { bgmUsername: true } },
      jellyfinConnections: { select: { id: true }, take: 1 },
      isAdmin: true,
    },
  });
  if (!user) return null;

  // 环境变量是管理员的权威来源：登录时同步到 DB，避免两处状态不一致。
  const shouldBeAdmin = isConfiguredAdmin(user.email);
  if (user.isAdmin !== shouldBeAdmin) {
    await prisma.user.update({ where: { id: userId }, data: { isAdmin: shouldBeAdmin } });
  }

  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    schoolId: user.schoolId,
    email: user.email,
    studentNo: user.studentNo,
    qqBound: user.qqBinding !== null,
    bgmBound: user.bgmBinding !== null,
    bgmUsername: user.bgmBinding?.bgmUsername ?? null,
    jellyfinConnected: user.jellyfinConnections.length > 0,
    isAdmin: shouldBeAdmin,
  };
}

/** 要求已登录，否则抛错（由 route handler 转成 401）。 */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("未登录");
    this.name = "UnauthorizedError";
  }
}

export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  /*
   * `secure` 必须按**真实连接协议**判定，不能用 NODE_ENV 推断。
   *
   * 原先写死 `NODE_ENV === "production"` —— 容器里它是 production，
   * 于是 Cookie 带 `Secure`，而浏览器拒绝在明文 HTTP 的非 localhost 源上
   * 存储它 → 从局域网 IP 访问时登录静默失效。
   * 详见 `cookie-policy.ts`。
   */
  const secure = resolveSecureCookie(await headers());
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
