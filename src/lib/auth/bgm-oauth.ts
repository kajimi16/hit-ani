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
import { isUniqueViolation } from "@/lib/prisma-errors";
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
  /** BGM 昵称（可能与 username 不同），缺失时为 null。 */
  nickname: string | null;
  /** BGM 头像三档地址，缺失时为 null。 */
  avatar: { large: string; medium: string; small: string } | null;
}

/**
 * 用 token 换身份。`GET /v0/me` 返回 `{ id, username, nickname, avatar, ... }`。
 * 这是**唯一**能确认 token 有效性的方式，两条绑定路径都先走它。
 *
 * 顺带把 `nickname` 与 `avatar` 也解析出来 —— 它们正是「导入头像」要用到的
 * 数据，且已在同一个响应里，没必要为此再打一次请求。
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

  const data = (await response.json()) as {
    username?: string;
    id?: number;
    nickname?: string;
    avatar?: { large?: string; medium?: string; small?: string };
  };
  if (!data.username || typeof data.id !== "number") {
    throw new Error("Bangumi 返回的用户信息缺少 username 或 id");
  }

  // 三档都要有才认 —— 缺档的地址会让 `next/image` 在渲染时抛错
  const avatar =
    data.avatar?.large && data.avatar.medium && data.avatar.small
      ? { large: data.avatar.large, medium: data.avatar.medium, small: data.avatar.small }
      : null;

  return {
    userId: data.id,
    username: data.username,
    nickname: data.nickname?.trim() || null,
    avatar,
  };
}

/**
 * 该 Bangumi 账号已经绑定到本站的**另一个**本地账号。
 *
 * 为什么不默默覆盖：一个 BGM 账号可能被两个本地账号关联（例如两人共用一个
 * BGM 账号），静默迁移会让另一边无声失去绑定。因此把决定权交给用户 ——
 * 见 `takeOver`。
 */
export class BgmAccountTakenError extends Error {
  constructor(
    readonly bgmUserId: number,
    /** 已持有该绑定的 BGM 用户名，用于把提示说得具体些。 */
    readonly bgmUsername: string | null,
  ) {
    super(
      `这个 Bangumi 账号${bgmUsername ? `（${bgmUsername}）` : ""}已经绑定到本站的另一个账号了。`,
    );
    this.name = "BgmAccountTakenError";
  }
}

interface BindingFields {
  bgmUserId: number;
  bgmUsername: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  personalToken: boolean;
}

/**
 * 由「该 BGM 账号当前的持有人」决定这次绑定该怎么做。
 *
 * 抽成纯函数是因为这里的分支正是出过问题的地方：`bgmUserId` 上有唯一约束，
 * 而原来的 `upsert({ where: { userId } })` 只按主键判断，于是「另一个本地账号
 * 已持有该 BGM 账号」时走 `create` 分支、直接撞唯一约束，把 Prisma 原文抛给用户。
 *
 * - `write`：无人持有，或持有人就是自己 —— 正常写入（自己重复绑定走 update）
 * - `conflict`：他人持有且未获授权 —— 交给调用方提示用户
 * - `take-over`：他人持有且用户已确认 —— 迁移到当前账号
 */
export function planBinding(
  holder: { userId: string } | null,
  userId: string,
  takeOver: boolean,
): "write" | "conflict" | "take-over" {
  if (!holder || holder.userId === userId) return "write";
  return takeOver ? "take-over" : "conflict";
}

/**
 * 写入绑定关系。
 *
 * 冲突的两种方向见 `planBinding`。原始表现是一条 Prisma 报错：
 *
 *     Invalid `prisma.bgmBinding.upsert()` invocation:
 *     Unique constraint failed on the fields: (`bgmUserId`)
 *
 * 把这句话甩给用户毫无意义（既是内部实现细节，也没告诉用户能做什么）。
 * 现在翻译成可操作的提示，并在 `takeOver` 为真时**显式迁移**。
 *
 * `takeOver` 是安全的：能提供该 BGM 账号的有效令牌，本身就是所有权的证明
 * （令牌等同于密码），因此「迁移到自己名下」不是越权。但它仍需要用户确认 ——
 * 静默迁移会让原来那个本地账号无声失去绑定。
 *
 * 删除旧行与写入新行放在同一个事务里 —— 否则迁移中途失败会让双方都失去绑定。
 */
async function saveBinding(
  userId: string,
  fields: BindingFields,
  takeOver: boolean,
): Promise<void> {
  const holder = await prisma.bgmBinding.findUnique({
    where: { bgmUserId: fields.bgmUserId },
    select: { userId: true, bgmUsername: true },
  });

  const plan = planBinding(holder, userId, takeOver);

  if (plan === "conflict") {
    throw new BgmAccountTakenError(fields.bgmUserId, holder?.bgmUsername ?? null);
  }

  if (plan === "take-over") {
    await prisma.$transaction([
      prisma.bgmBinding.deleteMany({
        where: { bgmUserId: fields.bgmUserId, userId: { not: userId } },
      }),
      prisma.bgmBinding.upsert({
        where: { userId },
        create: { userId, ...fields },
        update: fields,
      }),
    ]);
    return;
  }

  try {
    await prisma.bgmBinding.upsert({
      where: { userId },
      create: { userId, ...fields },
      update: fields,
    });
  } catch (error) {
    // 上面的检查与这里的写入之间可能有并发绑定插入 —— 兜住这种情况，
    // 返回同样的可识别错误让调用方决定是否迁移，而不是漏出 Prisma 原文。
    if (isUniqueViolation(error)) {
      const nowHeldBy = await prisma.bgmBinding.findUnique({
        where: { bgmUserId: fields.bgmUserId },
        select: { bgmUsername: true },
      });
      throw new BgmAccountTakenError(fields.bgmUserId, nowHeldBy?.bgmUsername ?? null);
    }
    throw error;
  }
}

/** 用 code 换 token 并落库绑定（OAuth 路径）。 */
export async function bindBgmAccount(
  userId: string,
  config: BgmOAuthConfig,
  code: string,
  options: { takeOver?: boolean } = {},
): Promise<{ bgmUserId: number }> {
  const token = await exchangeAuthorizationCode({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    redirectUri: config.redirectUri,
  });

  const identity = await fetchBgmIdentity(token.access_token);

  await saveBinding(
    userId,
    {
      bgmUserId: identity.userId,
      bgmUsername: identity.username,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
      personalToken: false,
    },
    options.takeOver ?? false,
  );

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
  options: { takeOver?: boolean } = {},
): Promise<{ bgmUserId: number; username: string; expiresAt: Date }> {
  const identity = await fetchBgmIdentity(token);
  const expiresAt =
    (await fetchTokenExpiry(token)) ??
    new Date(Date.now() + PERSONAL_TOKEN_ASSUMED_LIFETIME_MS);

  await saveBinding(
    userId,
    {
      bgmUserId: identity.userId,
      bgmUsername: identity.username,
      accessToken: token,
      // 个人令牌没有 refresh_token；留空字符串以便复用同一列而不改可空性
      refreshToken: "",
      expiresAt,
      personalToken: true,
    },
    options.takeOver ?? false,
  );

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
