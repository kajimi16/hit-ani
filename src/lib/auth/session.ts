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
  /**
   * 是否把站内操作同步写回 Bangumi。**默认 false** —— 见
   * `prisma/schema.prisma` 里 `User.mirrorToBgm` 的说明。
   */
  mirrorToBgm: boolean;
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
      mirrorToBgm: true,
      isAdmin: true,
    },
  });
  if (!user) return null;

  /*
   * 管理员来自**两个来源的并集**：环境变量 `ADMIN_EMAILS`，或 DB 里的
   * `User.isAdmin`（由 `npm run admin:grant` 设定）。
   *
   * 早先这里写的是 `shouldBeAdmin = isConfiguredAdmin(email)`，然后**把 DB
   * 值覆盖成它** —— 后果是 DB 授予的管理员在下一次请求时就被抹掉，
   * 于是「只有改 .env 并重启才能加管理员」。
   *
   * 为什么不做「首个注册的账号自动成为管理员」：本库的第一个用户是**种子
   * 账号 alice**，那条规则会把她变成管理员 —— 与「种子账号绝不可用于生产」
   * 直接冲突。显式授予（`admin:grant`）没有这个陷阱，且是可审计的。
   */
  const isAdmin = isConfiguredAdmin(user.email) || user.isAdmin;

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
    mirrorToBgm: user.mirrorToBgm,
    jellyfinConnected: user.jellyfinConnections.length > 0,
    isAdmin,
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
