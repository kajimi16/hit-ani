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
 * 会自愈的网络层错误码。
 *
 * 这些都不是「请求本身有问题」，而是链路抖动 —— 连接被重置、临时解析失败、
 * 套接字超时。它们由 undici 包成 `TypeError: fetch failed`，**真实原因在
 * `cause` 里**，只看外层 `message` 什么都看不出来。
 */
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * 遍历错误及其整条嵌套链，收集 `code`，并看是否出现过中止。
 *
 * 要往下挖是因为 undici 会把原因层层包裹：
 * `TypeError: fetch failed` → `cause: AggregateError` → `errors[i].code`。
 * 只查第一层会漏掉大部分真实原因。
 *
 * 中止与错误码**一起**收集而不是分两次遍历，是因为「主动取消」的判定必须
 * 覆盖整条链：中止同样会被包进 `fetch failed`，只看顶层 `name` 会漏 ——
 * 那种情况下重试的正是用户已经放弃的请求。
 */
function inspectErrorChain(
  error: unknown,
  depth = 0,
): { codes: string[]; aborted: boolean; timedOut: boolean } {
  if (depth > 4 || !(error instanceof Error)) {
    return { codes: [], aborted: false, timedOut: false };
  }

  // 用 `in` + `typeof` 窄化，而不是给 `error` 套一个「我猜的形状」再直接读字段 ——
  // 那样写即使形状不对也不会报错，读出来是错的。
  const codes: string[] = [];
  if ("code" in error && typeof error.code === "string") codes.push(error.code);

  const aborted = error.name === "AbortError";
  let timedOut = error.name === "TimeoutError";

  // undici 解析到多个地址时会把每个失败放进 `errors[]`
  const children: unknown[] =
    "errors" in error && Array.isArray(error.errors) ? error.errors : [error.cause];

  for (const child of children) {
    const nested = inspectErrorChain(child, depth + 1);
    codes.push(...nested.codes);
    timedOut ||= nested.timedOut;
    // 主动取消是「一票否决」：链上任何一环中止，整次请求就作废
    if (nested.aborted) return { codes, aborted: true, timedOut };
  }
  return { codes, aborted, timedOut };
}

/**
 * 判定某次失败是否值得重试。
 *
 * - 429 / 5xx：上游限流或抖动
 * - `TimeoutError`：我们自己的超时触发，值得重试
 * - **网络层瞬时错误**：连接被重置 / 临时解析失败等（见 `TRANSIENT_NETWORK_CODES`）
 *
 * **不**重试 `AbortError`：那是调用方主动取消（用户离开页面、任务被中止），
 * 重试只会把已放弃的工作重新捡起来。这个判定对**整条** cause 链生效。
 *
 * 加网络层错误这一条的原因很具体：此前只认 `TimeoutError` 与 429/5xx，
 * 而经代理访问上游时的典型失败是 `TypeError: fetch failed`（`ECONNRESET`）——
 * 它**既不是** `BgmApiError` 也不是 `TimeoutError`，于是被判为不可重试。
 * 实测并发请求的失败率约 1/16，用户侧表现为「点一下刷新就报加载失败」。
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof BgmApiError) {
    return error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  const { codes, aborted, timedOut } = inspectErrorChain(error);
  if (aborted) return false;
  if (timedOut) return true;
  return codes.some((code) => TRANSIENT_NETWORK_CODES.has(code));
}


export function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

/**
 * 带指数退避的重试。
 *
 * 可重试的判定见 `isRetryable`。`AbortError` 不重试 —— 那是调用方主动放弃。
 *
 * 放在网络层（而不是导入流程里）是因为它对本模块所有请求都适用：
 * 探索页、条目页、导入都走同一条链路，各自实现一份必然漂移。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) throw error;
      const backoff = BASE_BACKOFF_MS * 2 ** attempt;
      console.warn(`[bgm] ${label} 失败，${backoff}ms 后重试（第 ${attempt + 1} 次）`);
      await sleep(backoff);
    }
  }
  throw lastError;
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
