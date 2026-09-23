/**
 * 会话层：HMAC 签名的无状态 Cookie。
 *
 * 只保存 `userId`，其余信息每次请求回库读取 —— 便于封禁/改校后即时生效。
 * 学校维度（`schoolId`）是本校弹幕/评论筛选的根基，因此绝不由客户端传递，
 * 一律从会话 → 数据库读取。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

export const SESSION_COOKIE = "hitani_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value) {
    throw new Error("缺少环境变量 SESSION_SECRET");
  }
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
    },
  });
  if (!user) return null;

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

/** OAuth state 参数（防 CSRF），随会话 Cookie 短期存放。 */
export const OAUTH_STATE_COOKIE = "hitani_oauth_state";

export function generateOAuthState(): string {
  return randomBytes(16).toString("base64url");
}

export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
