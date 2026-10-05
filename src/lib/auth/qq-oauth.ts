/**
 * QQ 互联 账号绑定（OAuth2.0）。
 *
 * 与 BGM 的区别：QQ 走三个域名（authorize / token / openapi），
 * 且必须先拿 `openid` 才能取用户信息；`unionId` 仅在应用开通后返回。
 *
 * 需要环境变量：QQ_APP_ID / QQ_APP_KEY。
 */

import { prisma } from "@/lib/prisma";
import { isUniqueViolation } from "@/lib/prisma-errors";

const QQ_AUTHORIZE_URL = "https://graph.qq.com/oauth2.0/authorize";
const QQ_TOKEN_URL = "https://graph.qq.com/oauth2.0/token";
const QQ_OPENID_URL = "https://graph.qq.com/oauth2.0/me";
const QQ_USERINFO_URL = "https://graph.qq.com/user/get_user_info";

export interface QqOAuthConfig {
  appId: string;
  appKey: string;
  redirectUri: string;
}

export function readQqOAuthConfig(origin: string): QqOAuthConfig {
  const appId = process.env.QQ_APP_ID;
  const appKey = process.env.QQ_APP_KEY;
  if (!appId || !appKey) {
    throw new Error("缺少环境变量 QQ_APP_ID / QQ_APP_KEY");
  }
  const redirectUri = process.env.QQ_REDIRECT_URI ?? `${origin}/api/auth/qq/callback`;
  return { appId, appKey, redirectUri };
}

export function qqAuthorizeUrl(config: QqOAuthConfig, state: string): string {
  const url = new URL(QQ_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

/** QQ 的 token 接口返回 `application/x-www-form-urlencoded`，不是 JSON。 */
function parseFormEncoded(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) result[key] = value;
  return result;
}

async function exchangeCode(config: QqOAuthConfig, code: string): Promise<string> {
  const url = new URL(QQ_TOKEN_URL);
  url.searchParams.set("grant_type", "authorization_code");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("client_secret", config.appKey);
  url.searchParams.set("code", code);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("fmt", "json");

  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();

  // fmt=json 在部分网关下仍回落为 form 编码，两种都兼容
  const parsed = text.trim().startsWith("{")
    ? (JSON.parse(text) as Record<string, string>)
    : parseFormEncoded(text);

  if (parsed.error) {
    throw new Error(`QQ 换取 token 失败: ${parsed.error} ${parsed.error_description ?? ""}`);
  }
  if (!parsed.access_token) throw new Error("QQ 未返回 access_token");
  return parsed.access_token;
}

/**
 * 取 openid。QQ 的 `/oauth2.0/me` 返回 `callback( {...} );` 包裹格式，
 * 且历史上有 `callback( {"error":...} );` 形态，必须去除包裹再解析。
 */
async function fetchOpenId(accessToken: string): Promise<{ openId: string; unionId?: string }> {
  const url = new URL(QQ_OPENID_URL);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("fmt", "json");
  url.searchParams.set("unionid", "1");

  const response = await fetch(url, { cache: "no-store" });
  const text = (await response.text()).trim();

  const jsonText = text.startsWith("{")
    ? text
    : text.replace(/^callback\s*\(\s*/, "").replace(/\s*\)\s*;?\s*$/, "");

  const parsed = JSON.parse(jsonText) as { openid?: string; unionid?: string; error?: number; error_description?: string };
  if (parsed.error) throw new Error(`QQ 获取 openid 失败: ${parsed.error_description ?? parsed.error}`);
  if (!parsed.openid) throw new Error("QQ 未返回 openid");

  return { openId: parsed.openid, unionId: parsed.unionid };
}

/** 取 QQ 昵称/头像，用于首次绑定时回填用户资料。 */
export async function fetchQqUserInfo(
  config: QqOAuthConfig,
  accessToken: string,
  openId: string,
): Promise<{ nickname: string; avatarUrl: string | null }> {
  const url = new URL(QQ_USERINFO_URL);
  url.searchParams.set("access_token", accessToken);
  url.searchParams.set("oauth_consumer_key", config.appId);
  url.searchParams.set("openid", openId);

  const response = await fetch(url, { cache: "no-store" });
  const data = (await response.json()) as {
    ret?: number;
    msg?: string;
    nickname?: string;
    figureurl_qq_2?: string;
    figureurl_qq_1?: string;
  };

  if (data.ret !== undefined && data.ret !== 0) {
    throw new Error(`QQ 获取用户信息失败: ${data.msg ?? data.ret}`);
  }

  return {
    nickname: data.nickname ?? "QQ 用户",
    avatarUrl: data.figureurl_qq_2 ?? data.figureurl_qq_1 ?? null,
  };
}

/**
 * 该 QQ 已经被本站另一个账号绑定。
 *
 * 与 Bangumi 那边同源的问题：`QqBinding.userId` 是主键、`openId` 是唯一键，
 * 而 `upsert({ where: { userId } })` **只按主键判断**。当同一个 QQ 被第二个
 * 本地账号绑定时，它会走 `create` 分支撞上 `openId` 的唯一约束，把
 * `Unique constraint failed on the fields: (openId)` 这类 Prisma 原文
 * 直接甩给用户。
 *
 * QQ 这条路径**不做迁移**：它是跳转式 OAuth，回调里没有地方让用户确认，
 * 而静默解除另一账号的绑定不可接受（BGM 那条能确认，所以有 takeOver）。
 * 这里只把失败说清楚。
 */
export class QqAccountTakenError extends Error {
  constructor(readonly openId: string) {
    super("这个 QQ 已经绑定到本站的另一个账号了。请先在那个账号里解除绑定，再试。");
    this.name = "QqAccountTakenError";
  }
}

/** 绑定 QQ 到指定平台账号。 */
export async function bindQqAccount(
  userId: string,
  config: QqOAuthConfig,
  code: string,
): Promise<{ openId: string; nickname: string | null }> {
  const accessToken = await exchangeCode(config, code);
  const { openId, unionId } = await fetchOpenId(accessToken);
  const info = await fetchQqUserInfo(config, accessToken, openId);

  try {
    await prisma.qqBinding.upsert({
      where: { userId },
      create: { userId, openId, unionId: unionId ?? null },
      update: { openId, unionId: unionId ?? null },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new QqAccountTakenError(openId);
    throw error;
  }

  return { openId, nickname: info.nickname };
}

export async function unbindQqAccount(userId: string): Promise<void> {
  await prisma.qqBinding.deleteMany({ where: { userId } });
}
