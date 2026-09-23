/**
 * 公共弹幕源：dandanplay 客户端。
 *
 * 依据 Animeko `danmaku/dandanplay/.../DandanplayClient.kt` 的真实实现（docs/MEDIA.md §5）。
 *
 * 鉴权（每个请求都要带）：
 *   X-AppId / X-Timestamp(秒) / X-Signature = Base64(SHA256(appId + timestamp + path + appSecret))
 * 其中 `path` 是 **URL 的 path（不含 host 与 query）**。
 *
 * ⚠️ 需要自行申请 AppId/AppSecret（https://doc.dandanplay.com/open/）。
 * 未配置时 `isConfigured()` 返回 false，调用方应降级为「仅校内弹幕」而不是报错。
 */

import { createHash } from "node:crypto";
import { DanmakuLocation, type DanmakuLocationValue, type DanmakuDto } from "./types";

export const DANDANPLAY_BASE = "https://api.dandanplay.net";
/** 弹弹服务器较慢，Animeko 同样用 60s。 */
export const DANDANPLAY_TIMEOUT_MS = 60_000;
/** 每次请求之间的间隔，避免触发限流。 */
export const DANDANPLAY_REQUEST_INTERVAL_MS = 300;

export interface DandanplayCredentials {
  appId: string;
  appSecret: string;
}

/** 凭据是否已配置。未配置时调用方应跳过该源。 */
export function isConfigured(): boolean {
  return Boolean(process.env.DANDANPLAY_APP_ID && process.env.DANDANPLAY_APP_SECRET);
}

export function readCredentials(): DandanplayCredentials {
  const appId = process.env.DANDANPLAY_APP_ID;
  const appSecret = process.env.DANDANPLAY_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("缺少环境变量 DANDANPLAY_APP_ID / DANDANPLAY_APP_SECRET");
  }
  return { appId, appSecret };
}

/**
 * 计算请求签名。
 *
 * `path` 必须是 URL 的 path 部分（`/api/v2/...`），**不含 host 与 query string** ——
 * 这是最容易写错的地方，Animeko 用的是 `url.encodedPath`。
 */
export function generateSignature(
  appId: string,
  timestampSeconds: number,
  path: string,
  appSecret: string,
): string {
  const data = `${appId}${timestampSeconds}${path}${appSecret}`;
  return createHash("sha256").update(data, "utf8").digest("base64");
}

/** 构造鉴权头。`now` 可注入以便测试。 */
export function authHeaders(
  credentials: DandanplayCredentials,
  path: string,
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    "X-AppId": credentials.appId,
    "X-Timestamp": String(timestamp),
    "X-Signature": generateSignature(
      credentials.appId,
      timestamp,
      path,
      credentials.appSecret,
    ),
  };
}

export class DandanplayError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    readonly url: string,
  ) {
    super(`dandanplay ${status} on ${url}`);
    this.name = "DandanplayError";
  }
}

async function request<T>(
  path: string,
  query: Record<string, string | number | undefined> = {},
  init: RequestInit = {},
): Promise<T> {
  const credentials = readCredentials();
  const url = new URL(path, DANDANPLAY_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      ...authHeaders(credentials, url.pathname),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(DANDANPLAY_TIMEOUT_MS),
    cache: "no-store",
  });

  // 404 在弹弹语义里表示「没找到」，不是错误 —— 由调用方转成空结果。
  if (!response.ok) {
    let detail: unknown = null;
    try {
      detail = await response.json();
    } catch {
      detail = await response.text().catch(() => null);
    }
    throw new DandanplayError(response.status, detail, url.toString());
  }

  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

/** 404 视为「无结果」，其余错误照常抛出。 */
export function isEmptyResult(error: unknown): boolean {
  return error instanceof DandanplayError && error.status === 404;
}

/* ------------------------------------------------------------------ *
 * 数据模型（字段名与上游一致）
 * ------------------------------------------------------------------ */

export interface DandanplayEpisode {
  episodeId: number;
  episodeTitle: string;
  episodeNumber: string;
}

export interface DandanplayAnime {
  animeId: number;
  animeTitle: string;
  type?: string;
  typeDescription?: string;
  episodes?: DandanplayEpisode[];
}

export interface DandanplayComment {
  cid: number;
  /** `出现时间秒,模式,颜色,用户ID` */
  p: string;
  /** 弹幕文本 */
  m: string;
}

export interface DandanplayCommentResponse {
  count: number;
  comments: DandanplayComment[];
}

/* ------------------------------------------------------------------ *
 * 端点
 * ------------------------------------------------------------------ */

/** 取弹幕。`withRelated=true` 同时返回关联的第三方转存弹幕。 */
export function getComments(
  episodeId: number,
  options: { withRelated?: boolean; chConvert?: 0 | 1 | 2 } = {},
): Promise<DandanplayCommentResponse> {
  return request<DandanplayCommentResponse>(`/api/v2/comment/${episodeId}`, {
    // chConvert：0 不转换，1 转简体，2 转繁体。Animeko 硬编码 0（issue #122）。
    chConvert: options.chConvert ?? 0,
    withRelated: options.withRelated === false ? "false" : "true",
  });
}

/** 按 Bangumi subjectId 取剧集（**首选**匹配路径）。 */
export function getEpisodesByBgmtvSubjectId(
  bgmtvSubjectId: number,
): Promise<{ bangumi: DandanplayAnime }> {
  return request(`/api/v2/bangumi/bgmtv/${bgmtvSubjectId}`);
}

/** 按 dandanplay 自己的 bangumiId 取剧集。 */
export function getBangumi(bangumiId: number): Promise<{ bangumi: DandanplayAnime }> {
  return request(`/api/v2/bangumi/${bangumiId}`);
}

/** 季度番剧列表，用于「按别名精确匹配」。`month` 需为两位。 */
export function getSeasonAnimeList(
  year: number,
  month: number,
): Promise<{ bangumiList: DandanplayAnime[] }> {
  const padded = String(month).padStart(2, "0");
  return request(`/api/v2/bangumi/season/anime/${year}/${padded}`);
}

/** 番剧搜索（404 → 空结果，调用方用 `isEmptyResult` 判定）。 */
export function searchAnime(
  keyword: string,
): Promise<{ animes: DandanplayAnime[] }> {
  return request("/api/v2/search/anime", { keyword });
}

/** 剧集搜索。`episode` 传 undefined 表示不带集名（由本地算法匹配）。 */
export function searchEpisodes(
  anime: string,
  episode?: string,
): Promise<{ animes: DandanplayAnime[] }> {
  return request("/api/v2/search/episodes", { anime, episode });
}

/** 按文件名让弹弹自行匹配（兜底路径，命中率最低）。 */
export function matchVideo(params: {
  fileName: string;
  fileSize?: number;
  videoDurationSeconds?: number;
  matchMode?: "fileNameOnly" | "hashAndFileName";
  fileHash?: string;
}): Promise<{
  isMatched: boolean;
  matches: {
    animeId: number;
    animeTitle: string;
    episodeId: number;
    episodeTitle: string;
  }[];
}> {
  return request(
    "/api/v2/match",
    {},
    {
      method: "POST",
      body: JSON.stringify({
        fileName: params.fileName,
        ...(params.fileSize !== undefined ? { fileSize: params.fileSize } : {}),
        videoDuration: params.videoDurationSeconds ?? 0,
        // Animeko 当前恒用 fileNameOnly（仓库内 .http 示例的 hashAndFileName 已与代码不一致）
        matchMode: params.matchMode ?? "fileNameOnly",
        ...(params.fileHash ? { fileHash: params.fileHash } : {}),
      }),
    },
  );
}

/* ------------------------------------------------------------------ *
 * 弹幕转换
 * ------------------------------------------------------------------ */

/**
 * 把 dandanplay 的 `p` 字段解析成结构化弹幕。
 *
 * 格式：`出现时间(秒,两位小数),模式,颜色,用户ID`
 * 模式：1=滚动 4=底部 5=顶部，**其他一律丢弃**（对齐上游实现）。
 * 颜色：`R*256*256 + G*256 + B`。
 *
 * 返回 null 表示该条不可用 —— 调用方应跳过而不是塞入占位。
 */
export function parseDandanplayComment(
  comment: DandanplayComment,
  episodeId: number,
): DanmakuDto | null {
  const parts = comment.p.split(",");
  if (parts.length < 4) return null;

  const [timeRaw, modeRaw, colorRaw, userId] = parts;

  const seconds = Number(timeRaw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  const mode = Number(modeRaw);
  const location = DANDANPLAY_MODE_TO_LOCATION[mode];
  if (location === undefined) return null;

  const color = Number(colorRaw);
  if (!Number.isInteger(color) || color < 0 || color > 0xffffff) return null;

  const text = comment.m;
  if (!text) return null;

  return {
    id: `ddp-${comment.cid}`,
    episodeId,
    serviceId: "Dandanplay",
    senderId: userId || "unknown",
    senderName: "dandanplay",
    // 外部源没有学校归属；空串表示「非本校」，天然被 schoolOnly 过滤掉
    schoolId: "",
    playTimeMs: Math.round(seconds * 1000),
    color,
    text,
    location,
  };
}

/** 模式 → 位置。其他模式（如逆向滚动）不支持，返回 undefined 表示丢弃。 */
const DANDANPLAY_MODE_TO_LOCATION: Record<number, DanmakuLocationValue | undefined> = {
  1: DanmakuLocation.Normal,
  4: DanmakuLocation.Bottom,
  5: DanmakuLocation.Top,
};

export function parseComments(
  response: DandanplayCommentResponse,
  episodeId: number,
): DanmakuDto[] {
  return response.comments
    .map((comment) => parseDandanplayComment(comment, episodeId))
    .filter((item): item is DanmakuDto => item !== null);
}
