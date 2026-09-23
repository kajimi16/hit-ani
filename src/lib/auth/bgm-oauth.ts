/**
 * Bangumi 账号绑定。
 *
 * 两条绑定路径：
 *  1. **OAuth2 授权码模式**（正式、推荐）——用户点按钮跳转 bgm.tv 授权，我们只拿到 token，
 *     永不接触用户密码。需要 `BGM_CLIENT_ID` / `BGM_CLIENT_SECRET`。
 *  2. **个人访问令牌**（开发/自用）——用户自行在 Bangumi 生成 token 后粘贴，
 *     无需注册应用即可打通「一键导入」。token 相当于密码，必须服务端加密存储、永不回显。
 *
 * 约束（来自 docs-raw/How-to-Auth.md，已实测确认）：
 * - 授权域名 `https://bgm.tv/oauth/*`，业务 API 域名 `https://api.bgm.tv` —— 两者不同；
 * - `code` 有效期 60 秒，必须立刻换取 token；
 * - OAuth `access_token` 有效期 7 天（604800s），必须持久化 `refresh_token` 并定时刷新；
 * - 个人令牌没有 refresh_token，到期只能由用户重新生成。
 */

import { prisma } from "@/lib/prisma";
import {
  BGM_OAUTH_BASE,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  type BgmTokenResponse,
} from "@/lib/bgm/client";

export interface BgmOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** OAuth 应用凭据是否已配置 —— 未配置时只能走个人令牌路径。 */
export function isBgmOAuthConfigured(): boolean {
  return Boolean(process.env.BGM_CLIENT_ID && process.env.BGM_CLIENT_SECRET);
}

export function readBgmOAuthConfig(origin: string): BgmOAuthConfig {
  const clientId = process.env.BGM_CLIENT_ID;
  const clientSecret = process.env.BGM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "缺少环境变量 BGM_CLIENT_ID / BGM_CLIENT_SECRET。未注册应用时请改用「个人访问令牌」绑定。",
    );
  }
  const redirectUri =
    process.env.BGM_REDIRECT_URI ?? `${origin}/api/auth/bgm/callback`;
  return { clientId, clientSecret, redirectUri };
}

export function bgmAuthorizeUrl(config: BgmOAuthConfig, state: string): string {
  return buildAuthorizeUrl({
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
  });
}

export interface BgmIdentity {
  userId: number;
  username: string;
}

/**
 * 用 token 换身份。`GET /v0/me` 返回 `{ id, username, nickname, email, ... }`。
 * 这是**唯一**能确认 token 有效性的方式，两条绑定路径都先走它。
 */
export async function fetchBgmIdentity(accessToken: string): Promise<BgmIdentity> {
  const response = await fetch("https://api.bgm.tv/v0/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": process.env.BGM_USER_AGENT ?? "hit-ani/0.1 (https://github.com/hit-ani)",
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.status === 401) {
    throw new Error("Bangumi 令牌无效或已过期");
  }
  if (!response.ok) {
    throw new Error(`获取 Bangumi 用户信息失败: ${response.status}`);
  }

  const data = (await response.json()) as { username?: string; id?: number };
  if (!data.username || typeof data.id !== "number") {
    throw new Error("Bangumi 返回的用户信息缺少 username 或 id");
  }
  return { userId: data.id, username: data.username };
}

/** 用 code 换 token 并落库绑定（OAuth 路径）。 */
export async function bindBgmAccount(
  userId: string,
  config: BgmOAuthConfig,
  code: string,
): Promise<{ bgmUserId: number }> {
  const token = await exchangeAuthorizationCode({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    redirectUri: config.redirectUri,
  });

  const identity = await fetchBgmIdentity(token.access_token);
  const expiresAt = new Date(Date.now() + token.expires_in * 1000);

  const fields = {
    bgmUserId: identity.userId,
    bgmUsername: identity.username,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    personalToken: false,
  };

  await prisma.bgmBinding.upsert({
    where: { userId },
    create: { userId, ...fields },
    update: fields,
  });

  return { bgmUserId: identity.userId };
}

/**
 * 查询令牌到期时间。OAuth 令牌可用 `POST /bgm.tv/oauth/token_status`；
 * 个人令牌通常不被该端点接受，失败时返回 null 由调用方兜底。
 */
async function fetchTokenExpiry(accessToken: string): Promise<Date | null> {
  try {
    const response = await fetch(`${BGM_OAUTH_BASE}/token_status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": process.env.BGM_USER_AGENT ?? "hit-ani/0.1 (https://github.com/hit-ani)",
      },
      body: new URLSearchParams({ access_token: accessToken }),
      cache: "no-store",
    });
    if (!response.ok) return null;

    const data = (await response.json()) as { expires?: number };
    if (!data.expires || !Number.isFinite(data.expires)) return null;
    return new Date(data.expires * 1000);
  } catch {
    return null;
  }
}

/** 个人令牌无法查询到期时间时的保守假设：1 年。 */
const PERSONAL_TOKEN_ASSUMED_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 绑定用户自行生成的 Bangumi 个人访问令牌。
 *
 * 无需注册 OAuth 应用即可打通全部只读能力与进度回写 —— 适合学校内部自用部署。
 * 令牌先经 `/v0/me` 校验，无效直接拒绝，避免落库一个死令牌。
 */
export async function bindBgmPersonalToken(
  userId: string,
  token: string,
): Promise<{ bgmUserId: number; username: string; expiresAt: Date }> {
  const identity = await fetchBgmIdentity(token);
  const expiresAt =
    (await fetchTokenExpiry(token)) ??
    new Date(Date.now() + PERSONAL_TOKEN_ASSUMED_LIFETIME_MS);

  const fields = {
    bgmUserId: identity.userId,
    bgmUsername: identity.username,
    accessToken: token,
    // 个人令牌没有 refresh_token；留空字符串以便复用同一列而不改可空性
    refreshToken: "",
    expiresAt,
    personalToken: true,
  };

  await prisma.bgmBinding.upsert({
    where: { userId },
    create: { userId, ...fields },
    update: fields,
  });

  return { bgmUserId: identity.userId, username: identity.username, expiresAt };
}

/** 未绑定 Bangumi —— 调用方应引导用户去设置页绑定。 */
export class BgmNotBoundError extends Error {
  constructor() {
    super("尚未绑定 Bangumi 账号");
    this.name = "BgmNotBoundError";
  }
}

/** 提前 1 天视为过期，留出刷新窗口。 */
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export function isBgmTokenExpiring(expiresAt: Date, now = Date.now()): boolean {
  return expiresAt.getTime() - now <= REFRESH_THRESHOLD_MS;
}

/** 个人令牌过期 —— 无 refresh_token，只能请用户重新生成。 */
export class BgmTokenExpiredError extends Error {
  constructor() {
    super("Bangumi 个人令牌已过期，请在设置页重新生成并粘贴");
    this.name = "BgmTokenExpiredError";
  }
}

/**
 * 取得可用的 access_token。
 *
 * - OAuth 绑定：临近过期时用 refresh_token 续期；
 * - 个人令牌绑定：无 refresh_token，过期只能抛 `BgmTokenExpiredError` 让用户重绑定。
 *
 * `origin` 仅在需要刷新时才用于解析 OAuth 回调地址 —— 未配置应用凭据的部署
 * （纯个人令牌模式）不会走到那里。
 */
export async function getFreshBgmAccessToken(
  userId: string,
  origin: string,
): Promise<{ accessToken: string; bgmUsername: string }> {
  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  if (!binding) throw new BgmNotBoundError();

  if (!isBgmTokenExpiring(binding.expiresAt)) {
    return { accessToken: binding.accessToken, bgmUsername: binding.bgmUsername };
  }

  if (binding.personalToken) throw new BgmTokenExpiredError();

  const config = readBgmOAuthConfig(origin);
  const refreshed: BgmTokenResponse = await refreshAccessToken({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    refreshToken: binding.refreshToken,
    redirectUri: config.redirectUri,
  });

  await prisma.bgmBinding.update({
    where: { userId },
    data: {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
    },
  });

  return { accessToken: refreshed.access_token, bgmUsername: binding.bgmUsername };
}

export async function unbindBgmAccount(userId: string): Promise<void> {
  await prisma.bgmBinding.deleteMany({ where: { userId } });
}

export { BGM_OAUTH_BASE };
