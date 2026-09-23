/**
 * Jellyfin / Emby 客户端。
 *
 * 为什么选这条路（见 docs/MEDIA.md §6）：
 * **视频字节从 Jellyfin 直连浏览器，不经过本服务。** 平台只做「索引 + 播放地址生成」，
 * 因此不承担带宽成本，也不成为内容分发方。对本项目尤其关键 —— 校内服务器带宽本来就不够。
 *
 * 契约依据：Jellyfin 官方 OpenAPI（`https://api.jellyfin.org/openapi/jellyfin-openapi-stable.json`，
 * 实测实例 12.1.0，294 个端点）。关键事实：
 *
 * - 认证头：`Authorization: MediaBrowser Client="…", Device="…", DeviceId="…", Version="…", Token="…"`
 *   **即使登录请求也必须带设备信息**，否则服务端 `request.App` 为空而抛异常（实测 400）。
 * - 登录：`POST /Users/AuthenticateByName` body `{Username, Pw}` → `{AccessToken, ServerId, User}`
 * - 搜索：`GET /Items?searchTerm=&includeItemTypes=Series&recursive=true`
 * - 剧集：`GET /Shows/{seriesId}/Episodes?userId=`
 * - 直链：`GET /Videos/{itemId}/stream?static=true&api_key=` ← **`static=true` 关闭转码**
 *
 * Emby 兼容：Emby 用 `X-Emby-Token` 头，且接受 `?api_key=`。两者本模块都支持。
 */

import { assertSafeUrl } from "./url-safety";

/** 单次 API 请求超时。 */
export const JELLYFIN_TIMEOUT_MS = 15_000;
/** 客户端标识，会出现在 Jellyfin 的会话列表里。 */
export const CLIENT_NAME = "hit-ani";
export const CLIENT_VERSION = "0.1.0";

export class JellyfinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "JellyfinError";
  }
}

/** 服务端公开信息（无需认证）。 */
export interface JellyfinPublicInfo {
  ServerName: string;
  Version: string;
  Id: string;
  /** 为 false 表示服务端还没完成初始化向导 —— 此时无法登录。 */
  StartupWizardCompleted: boolean;
  ProductName?: string;
}

/** 登录结果。 */
export interface JellyfinAuthResult {
  accessToken: string;
  serverId: string;
  userId: string;
  userName: string;
  /** true 表示是管理员账号。 */
  isAdministrator: boolean;
}

/** Jellyfin 的条目（BaseItemDto 的子集，只保留用得到的字段）。 */
export interface JellyfinItem {
  Id: string;
  Name: string;
  /** 所属系列名（剧集条目才有）。 */
  SeriesName?: string | null;
  /** 季内集号。 */
  IndexNumber?: number | null;
  /** 季号。 */
  ParentIndexNumber?: number | null;
  /** 时长，单位 100 纳秒（.NET ticks）。 */
  RunTimeTicks?: number | null;
  Type?: string;
  SeriesId?: string | null;
  ProductionYear?: number | null;
  /** 观看进度。 */
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number | null } | null;
}

/** `RunTimeTicks` → 毫秒。100 纳秒一个 tick → 1 tick = 1e-4 ms。 */
export function ticksToMs(ticks: number | null | undefined): number | null {
  if (typeof ticks !== "number" || !Number.isFinite(ticks)) return null;
  return Math.round(ticks / 10_000);
}

/**
 * 判断地址是否是「只能本机访问」的环回地址。
 *
 * 为什么必须识别：播放地址是**由浏览器直接访问**的（`<video src>`）。
 * 若填 `localhost`，学生从自己电脑打开页面时，浏览器会把它解析成**学生自己的机器**，
 * 播放必然失败 —— 而且只有服务器上的人能看，问题极难被察觉。
 * 校内多人使用的场景下这几乎总是配置错误。
 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** 归一化 baseUrl：补协议、去尾斜杠。 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * 构造认证头。
 *
 * 即使未登录也要带（服务端需要 `request.App` 才会处理请求）。
 * `token` 留空表示未认证。
 */
export function authorizationHeader(token?: string, deviceId = "hit-ani-web"): string {
  const parts = [
    `Client="${CLIENT_NAME}"`,
    `Device="Web"`,
    `DeviceId="${deviceId}"`,
    `Version="${CLIENT_VERSION}"`,
  ];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

interface RequestOptions {
  token?: string;
  /** 允许内网地址（Jellyfin 常部署在校园网/家庭局域网）。 */
  allowPrivateHost?: boolean;
  timeoutMs?: number;
}

async function jfFetch<T>(
  baseUrl: string,
  path: string,
  options: RequestOptions & { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const base = normalizeBaseUrl(baseUrl);
  if (base === null) throw new JellyfinError("服务器地址格式不合法");

  const url = new URL(path, base);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  // SSRF 校验。Jellyfin 常在局域网，因此允许显式放开内网（由调用方决定）。
  if (options.allowPrivateHost) {
    // 仍校验协议与格式，但不拦内网
    await assertSafeUrl(url.toString(), { allowPrivate: true });
  } else {
    await assertSafeUrl(url.toString());
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: authorizationHeader(options.token),
  };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? JELLYFIN_TIMEOUT_MS),
      redirect: "manual",
      cache: "no-store",
    });
  } catch (error) {
    // 把底层网络错误翻译成可行动的说明 —— "fetch failed" 对用户没有意义
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      throw new JellyfinError(`连接超时：${url.host} 无响应`, undefined, url.toString());
    }
    if (cause === "ECONNREFUSED") {
      throw new JellyfinError(
        `连接被拒绝：${url.host} 上没有服务在监听（检查端口是否正确）`,
        undefined,
        url.toString(),
      );
    }
    if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") {
      throw new JellyfinError(`域名解析失败：${url.host}`, undefined, url.toString());
    }
    throw new JellyfinError(
      `无法连接 ${url.host}${cause ? `（${cause}）` : ""}`,
      undefined,
      url.toString(),
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      /* 忽略读取失败 */
    }
    const hint =
      response.status === 401
        ? "（用户名或密码错误，或服务器未完成初始化）"
        : response.status === 403
          ? "（账号无权限）"
          : "";
    throw new JellyfinError(
      `Jellyfin 返回 ${response.status}${hint}${detail ? `：${detail}` : ""}`,
      response.status,
      url.toString(),
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * 探测服务器（**无需认证**）。
 *
 * 用于「测试连接」按钮：能区分「地址不通」「不是 Jellyfin」「未完成初始化」三种情况，
 * 比直接试登录的错误信息有用得多。
 */
export async function probeServer(
  baseUrl: string,
  options: { allowPrivateHost?: boolean } = {},
): Promise<JellyfinPublicInfo> {
  const info = await jfFetch<JellyfinPublicInfo>(baseUrl, "/System/Info/Public", {
    allowPrivateHost: options.allowPrivateHost,
  });
  if (typeof info?.ServerName !== "string") {
    throw new JellyfinError("目标地址不是 Jellyfin 服务器（响应缺少 ServerName）");
  }
  return info;
}

/** 用用户名密码换取 access token。 */
export async function authenticate(
  baseUrl: string,
  username: string,
  password: string,
  options: { allowPrivateHost?: boolean } = {},
): Promise<JellyfinAuthResult> {
  const result = await jfFetch<{
    AccessToken?: string;
    ServerId?: string;
    User?: { Id?: string; Name?: string; Policy?: { IsAdministrator?: boolean } };
  }>(baseUrl, "/Users/AuthenticateByName", {
    method: "POST",
    body: { Username: username, Pw: password },
    allowPrivateHost: options.allowPrivateHost,
  });

  if (!result?.AccessToken || !result.User?.Id) {
    throw new JellyfinError("Jellyfin 未返回访问令牌");
  }

  return {
    accessToken: result.AccessToken,
    serverId: result.ServerId ?? "",
    userId: result.User.Id,
    userName: result.User.Name ?? username,
    isAdministrator: result.User.Policy?.IsAdministrator === true,
  };
}

/** 搜索剧集（Series）。 */
export async function searchSeries(
  baseUrl: string,
  token: string,
  userId: string,
  keyword: string,
  options: { limit?: number; allowPrivateHost?: boolean } = {},
): Promise<JellyfinItem[]> {
  const result = await jfFetch<{ Items?: JellyfinItem[] }>(baseUrl, "/Items", {
    token,
    allowPrivateHost: options.allowPrivateHost,
    query: {
      userId,
      searchTerm: keyword,
      includeItemTypes: "Series",
      recursive: "true",
      limit: options.limit ?? 20,
      fields: "ProductionYear,Path",
    },
  });
  return result?.Items ?? [];
}

/** 列出某系列的全部剧集。 */
export async function listEpisodes(
  baseUrl: string,
  token: string,
  userId: string,
  seriesId: string,
  options: { allowPrivateHost?: boolean } = {},
): Promise<JellyfinItem[]> {
  const result = await jfFetch<{ Items?: JellyfinItem[] }>(
    baseUrl,
    `/Shows/${encodeURIComponent(seriesId)}/Episodes`,
    {
      token,
      allowPrivateHost: options.allowPrivateHost,
      query: { userId, fields: "ProductionYear" },
    },
  );
  return result?.Items ?? [];
}

/**
 * 构造**直连播放**地址。
 *
 * 两个关键点：
 * 1. `static=true` —— 原样传输不做转码。转码会吃 Jellyfin 服务器的 CPU，
 *    而原画直传对本场景（局域网、带宽受限）是唯一合理选择。
 * 2. token 走 query（`api_key`）—— `<video src>` 无法自定义请求头，这是唯一途径。
 *    该 token 是**用户自己的** Jellyfin 凭据，与本站会话无关。
 *
 * ⚠️ 视频字节由浏览器直连 Jellyfin，**不经过本服务**。
 */
export function buildStreamUrl(
  baseUrl: string,
  itemId: string,
  token: string,
  options: { container?: string } = {},
): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base === null) throw new JellyfinError("服务器地址格式不合法");

  const url = new URL(
    `/Videos/${encodeURIComponent(itemId)}/stream`,
    base,
  );
  url.searchParams.set("static", "true");
  url.searchParams.set("api_key", token);
  if (options.container) url.searchParams.set("container", options.container);
  return url.toString();
}

/** 海报地址（同样直连 Jellyfin）。 */
export function buildImageUrl(
  baseUrl: string,
  itemId: string,
  options: { maxHeight?: number; tag?: string } = {},
): string {
  const base = normalizeBaseUrl(baseUrl) ?? baseUrl;
  const url = new URL(`/Items/${encodeURIComponent(itemId)}/Images/Primary`, base);
  url.searchParams.set("maxHeight", String(options.maxHeight ?? 300));
  if (options.tag) url.searchParams.set("tag", options.tag);
  return url.toString();
}
