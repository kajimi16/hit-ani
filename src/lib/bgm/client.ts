/**
 * Bangumi API 类型化客户端。
 *
 * 类型来源：`src/lib/bgm/schema.d.ts`，由 `npm run bgm:types` 从
 * `.bgm-v0.yaml`（上游 bangumi/api 的 OpenAPI 规范）生成 —— 禁止手写 BGM interface。
 *
 * 域名区分（重要，易踩坑）：
 * - 业务 API  : https://api.bgm.tv
 * - OAuth 授权: https://bgm.tv/oauth/*   （不是 api.bgm.tv）
 */

import type { components, operations } from "./schema";

export const BGM_API_BASE = "https://api.bgm.tv";
export const BGM_OAUTH_BASE = "https://bgm.tv/oauth";

/** Bangumi 要求可识别的 UA 并附带联系方式。 */
export const BGM_USER_AGENT =
  process.env.BGM_USER_AGENT ?? "hit-ani/0.1 (https://github.com/hit-ani)";

/** 条目类型，对齐 `SubjectType`。 */
export const SubjectType = {
  Book: 1,
  Anime: 2,
  Music: 3,
  Game: 4,
  Real: 6,
} as const;

/**
 * 条目收藏类型，对齐 `SubjectCollectionType`。
 *
 * ⚠️ **2 与 3 的顺序反直觉**：`2` 是「看过」，`3` 才是「在看」。
 * 权威映射与展示顺序统一在 `@/lib/collection`，此处只保留与上游一致的命名。
 */
export const CollectionType = {
  Wish: 1,
  /** 看过 */
  Done: 2,
  /** 在看 */
  Doing: 3,
  OnHold: 4,
  Dropped: 5,
} as const;
export const EpisodeCollectionType = {
  None: 0,
  Wish: 1,
  Done: 2,
  Dropped: 3,
} as const;

/* ------------------------------------------------------------------ *
 * 从生成的 `operations` 取具体类型，避免手写 interface 随 API 漂移。
 * ------------------------------------------------------------------ */

type JsonContent<T> = T extends { content: { "application/json": infer R } } ? R : never;

/** 某操作的 200 响应体。 */
type OkBody<Op extends keyof operations> = operations[Op] extends {
  responses: Record<number, unknown>;
}
  ? JsonContent<operations[Op]["responses"][200]>
  : never;

/** 某操作的查询参数对象。 */
type QueryOf<Op extends keyof operations> = operations[Op] extends {
  parameters: { query?: infer Q };
}
  ? NonNullable<Q>
  : never;

/** 某操作的请求体（JSON）。 */
type BodyOf<Op extends keyof operations> = operations[Op] extends {
  requestBody?: infer B;
}
  ? B extends { content: { "application/json": infer R } }
    ? R
    : never
  : never;

export type SubjectSearchBody = BodyOf<"searchSubjects">;
export type PagedSubjects = OkBody<"searchSubjects">;
export type Subject = OkBody<"getSubjectById">;
export type Episode = components["schemas"]["Episode"];
export type EpisodeDetail = OkBody<"getEpisodeById">;
export type PagedEpisodes = OkBody<"getEpisodes">;
export type PagedUserCollections = OkBody<"getUserCollectionsByUsername">;
export type UserSubjectCollection = components["schemas"]["UserSubjectCollection"];
export type PagedUserEpisodeCollections = OkBody<"getUserSubjectEpisodeCollection">;

export class BgmApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    readonly url: string,
  ) {
    super(`Bangumi API ${status} on ${url}`);
    this.name = "BgmApiError";
  }
}

/**
 * 单次上游请求的超时。
 *
 * 为什么必须有：Node 的 `fetch`（undici）对响应体没有默认超时。上游或中间代理
 * 一旦只建连不应答，请求会永久挂起 —— 而 `withRetry` 只对**抛出的异常**重试，
 * 挂起不抛异常，于是整条导入链路会无声卡死（用户看到「导入中」永远不结束）。
 */
export const BGM_REQUEST_TIMEOUT_MS = Number(
  process.env.BGM_REQUEST_TIMEOUT_MS ?? 15_000,
);

/**
 * 判定某次失败是否值得重试。
 *
 * - 429 / 5xx：上游限流或抖动
 * - `TimeoutError`：我们自己的超时触发，值得重试
 *
 * **不**重试 `AbortError`：那是调用方主动取消（用户离开页面、任务被中止），
 * 重试只会把已放弃的工作重新捡起来。
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof BgmApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof Error && error.name === "TimeoutError";
}

export interface BgmRequestOptions {
  /** 用户 access_token，需要 `write:collection` 的接口必须提供。 */
  accessToken?: string;
  /** 调用方自己的中止信号；与内置超时取「先到先中止」。 */
  signal?: AbortSignal;
  /** 覆盖默认超时，毫秒。 */
  timeoutMs?: number;
}

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const url = new URL(path, BGM_API_BASE);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * 合成「内置超时 + 调用方信号」。
 * `AbortSignal.any` 在任一路中止时中止，且保留中止原因的 `name`
 * （timeout → `TimeoutError`，调用方取消 → `AbortError`），
 * 这正是不重试用户主动取消的依据。
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function request<T>(
  path: string,
  init: RequestInit & {
    query?: Record<string, unknown>;
    accessToken?: string;
    timeoutMs?: number;
  },
): Promise<T> {
  const { query, accessToken, timeoutMs, ...rest } = init;
  const url = buildUrl(path, query);
  const signal = withTimeout(rest.signal ?? undefined, timeoutMs ?? BGM_REQUEST_TIMEOUT_MS);

  const response = await fetch(url, {
    ...rest,
    signal,
    headers: {
      "User-Agent": BGM_USER_AGENT,
      Accept: "application/json",
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...rest.headers,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = await response.json();
    } catch {
      detail = await response.text().catch(() => null);
    }
    throw new BgmApiError(response.status, detail, url);
  }

  // 写接口可能返回 202/204 或「200 + 空 body」——例如
  // `POST /v0/users/-/collections/{id}` 实测返回 202 且 content-length: 0。
  // 直接 `response.json()` 会抛 "Unexpected end of JSON input"，
  // 让一次**已经成功**的上游写入被误判为失败（曾导致收藏同步一直报错）。
  // 因此先看状态码，再按空 body 兜底。
  if (response.status === 204 || response.status === 202) return undefined as T;

  const text = await response.text();
  if (text.length === 0) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BgmApiError(response.status, text.slice(0, 500), url);
  }
}

/* ------------------------------------------------------------------ *
 * 只读接口（无需授权）
 * ------------------------------------------------------------------ */

/** 条目搜索：关键词 + 标签/评分/日期/排名筛选。 */
export function searchSubjects(
  body: SubjectSearchBody,
  query: QueryOf<"searchSubjects"> = {},
  options: BgmRequestOptions = {},
): Promise<PagedSubjects> {
  return request("/v0/search/subjects", {
    method: "POST",
    body: JSON.stringify(body),
    query: query as Record<string, unknown>,
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * 单集详情。含 `subject_id` —— 用于校验本地「剧集 → 条目」映射是否与上游一致。
 *
 * 为什么需要这个校验：BGM 的 episode id 是全局的，本地若把它挂到了错误的条目上，
 * 进度回写会静默污染**另一个条目**的某一集。
 */
export function getEpisode(
  episodeId: number,
  options: BgmRequestOptions = {},
): Promise<EpisodeDetail> {
  return request(`/v0/episodes/${episodeId}`, {
    method: "GET",
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/** 条目详情。 */
export function getSubject(
  subjectId: number,
  options: BgmRequestOptions = {},
): Promise<Subject> {
  return request(`/v0/subjects/${subjectId}`, {
    method: "GET",
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/** 条目的章节列表（用于弹幕挂载点的 episodeId 来源）。 */
export function getSubjectEpisodes(
  subjectId: number,
  query: Omit<QueryOf<"getEpisodes">, "subject_id"> = {},
  options: BgmRequestOptions = {},
): Promise<PagedEpisodes> {
  return request("/v0/episodes", {
    method: "GET",
    query: { subject_id: subjectId, ...(query as Record<string, unknown>) },
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * 用户收藏列表（公开可读；含私有收藏时需 accessToken）。
 * `limit` 上限 100，配合 offset 分页做「一键导入」。
 */
export function getUserCollections(
  username: string,
  query: QueryOf<"getUserCollectionsByUsername"> = {},
  options: BgmRequestOptions = {},
): Promise<PagedUserCollections> {
  return request(`/v0/users/${encodeURIComponent(username)}/collections`, {
    method: "GET",
    query: query as Record<string, unknown>,
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * 某条目下「我」的章节收藏进度（含观看状态）。
 * 需 `write:collection` 授权 —— 一键导入进度依赖此接口。
 */
export function getUserSubjectEpisodeCollection(
  subjectId: number,
  query: Omit<QueryOf<"getUserSubjectEpisodeCollection">, "subject_id"> = {},
  options: BgmRequestOptions = {},
): Promise<PagedUserEpisodeCollections> {
  return request(`/v0/users/-/collections/${subjectId}/episodes`, {
    method: "GET",
    query: query as Record<string, unknown>,
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/* ------------------------------------------------------------------ *
 * 写接口（需 write:collection）
 * ------------------------------------------------------------------ */

/** 新增或修改条目收藏（含评分 / 短评 / 标签）。 */
export function postUserCollection(
  subjectId: number,
  body: BodyOf<"postUserCollection">,
  options: BgmRequestOptions = {},
): Promise<void> {
  return request(`/v0/users/-/collections/${subjectId}`, {
    method: "POST",
    body: JSON.stringify(body),
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/** 更新单集观看进度。 */
export function putEpisodeCollection(
  episodeId: number,
  type: number,
  options: BgmRequestOptions = {},
): Promise<void> {
  return request(`/v0/users/-/collections/-/episodes/${episodeId}`, {
    method: "PUT",
    body: JSON.stringify({ type }),
    accessToken: options.accessToken,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

/* ------------------------------------------------------------------ *
 * OAuth2（授权码模式）— 注意域名是 bgm.tv 而非 api.bgm.tv
 * ------------------------------------------------------------------ */

export interface BgmTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string | null;
  refresh_token: string;
  user_id: number;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("/oauth/authorize", BGM_OAUTH_BASE);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

async function postToken(form: Record<string, string>): Promise<BgmTokenResponse> {
  const response = await fetch(`${BGM_OAUTH_BASE}/access_token`, {
    method: "POST",
    headers: {
      "User-Agent": BGM_USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new BgmApiError(
      response.status,
      await response.text().catch(() => null),
      "/oauth/access_token",
    );
  }
  return (await response.json()) as BgmTokenResponse;
}

/** 用授权码换 token。`code` 有效期仅 60 秒。 */
export function exchangeAuthorizationCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<BgmTokenResponse> {
  return postToken({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
}

/** 刷新 token。`access_token` 有效期 7 天，需常驻刷新任务。 */
export function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  redirectUri: string;
}): Promise<BgmTokenResponse> {
  return postToken({
    grant_type: "refresh_token",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    refresh_token: params.refreshToken,
    redirect_uri: params.redirectUri,
  });
}
