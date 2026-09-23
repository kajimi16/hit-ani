/**
 * 媒体源服务层 —— 配置的 CRUD 与「搜索 / 解析」编排。
 *
 * 分工：
 *  - `source-config.ts` 纯配置模型与校验
 *  - `extract.ts`        纯解析
 *  - `fetcher.ts`        网络（含 SSRF 防护）
 *  - **本模块**          把三者串起来 + 落库
 *
 * 设计取舍：单个源失败**不阻断**其它源（对齐 Animeko 的 `DanmakuFetcher` 做法）——
 * 一个站点挂掉就整页空白是最差的用户体验，也是第三方源场景下必然发生的事。
 */

import { prisma } from "@/lib/prisma";
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  KeywordMode,
  SourceFactory,
  deriveBaseUrl,
  expandTemplate,
  hasKeywordPlaceholder,
  sourceConfigSchema,
  transformKeyword,
  type RssConfig,
  type SourceConfig,
  type WebSelectorConfig,
} from "./source-config";
import {
  extractEpisodes,
  extractSearchResults,
  filterFeedItems,
  parseFeed,
  type ExtractionDiagnostics,
  type RssItem,
  type SearchResultItem,
} from "./extract";
import { FetchError, fetchText, respectRateLimit } from "./fetcher";
import { UnsafeUrlError } from "./url-safety";

export interface MediaSourceRecord {
  id: string;
  name: string;
  description: string | null;
  factory: string;
  config: SourceConfig["config"];
  enabled: boolean;
  priority: number;
}

export interface SourceSearchResult {
  sourceId: string;
  sourceName: string;
  factory: string;
  /** 该源是否成功返回（false 时 `error` 有值） */
  ok: boolean;
  error: string | null;
  items: SearchResultItem[];
  /** web-selector 才有 */
  diagnostics: ExtractionDiagnostics | null;
  /** rss 才有 */
  feedItems: RssItem[];
}

/* ------------------------------------------------------------------ *
 * CRUD
 * ------------------------------------------------------------------ */

function toRecord(row: {
  id: string;
  name: string;
  description: string | null;
  factory: string;
  config: unknown;
  enabled: boolean;
  priority: number;
}): MediaSourceRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    factory: row.factory,
    config: row.config as SourceConfig["config"],
    enabled: row.enabled,
    priority: row.priority,
  };
}

export async function listSources(onlyEnabled = false): Promise<MediaSourceRecord[]> {
  const rows = await prisma.mediaSource.findMany({
    where: onlyEnabled ? { enabled: true } : {},
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toRecord);
}

export async function getSource(id: string): Promise<MediaSourceRecord | null> {
  const row = await prisma.mediaSource.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
}

export interface UpsertSourceInput {
  name: string;
  description?: string | null;
  factory: string;
  config: unknown;
  enabled?: boolean;
  priority?: number;
}

/**
 * 校验并保存源配置。
 *
 * 校验在**写入前**做：一个选择器写错的源会在每次搜索时都发起网络请求然后失败，
 * 让用户在保存时就发现比在运行时发现好得多。
 */
export async function createSource(input: UpsertSourceInput): Promise<MediaSourceRecord> {
  const parsed = sourceConfigSchema.parse({
    factory: input.factory,
    config: input.config,
  });

  if (parsed.factory === SourceFactory.WebSelector) {
    assertSearchTemplateUsable(parsed.config.searchUrl);
  } else {
    assertSearchTemplateUsable(parsed.config.searchUrl);
  }

  const row = await prisma.mediaSource.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      factory: parsed.factory,
      config: parsed.config as never,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
    },
  });
  return toRecord(row);
}

export async function updateSource(
  id: string,
  input: Partial<UpsertSourceInput>,
): Promise<MediaSourceRecord> {
  const existing = await prisma.mediaSource.findUnique({ where: { id } });
  if (!existing) throw new Error("源不存在");

  const factory = input.factory ?? existing.factory;
  const rawConfig = input.config ?? existing.config;

  const parsed = sourceConfigSchema.parse({ factory, config: rawConfig });
  assertSearchTemplateUsable(parsed.config.searchUrl);

  const row = await prisma.mediaSource.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      factory: parsed.factory,
      config: parsed.config as never,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
  return toRecord(row);
}

export async function deleteSource(id: string): Promise<void> {
  await prisma.mediaSource.deleteMany({ where: { id } });
}

/** 搜索模板必须含关键词占位符，否则每次搜索都返回同一页 —— 属于配置错误。 */
function assertSearchTemplateUsable(searchUrl: string): void {
  if (!hasKeywordPlaceholder(searchUrl)) {
    throw new Error("搜索地址模板必须包含 {keyword} 占位符，否则搜索结果不会随关键词变化");
  }
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

/**
 * 用全部启用的源搜索关键词。
 *
 * 串行执行（不是并发）：并发会瞬间打出一批请求，既容易触发对方限流，
 * 也让限速形同虚设。校内自用场景对延迟不敏感，稳定性优先。
 */
export async function searchAllSources(
  keyword: string,
  options: { sourceIds?: string[]; maxResultsPerSource?: number } = {},
): Promise<SourceSearchResult[]> {
  const sources = await listSources(true);
  const selected = options.sourceIds
    ? sources.filter((source) => options.sourceIds!.includes(source.id))
    : sources;

  const results: SourceSearchResult[] = [];
  for (const source of selected) {
    results.push(await searchOneSource(source, keyword, options.maxResultsPerSource));
  }
  return results;
}

async function searchOneSource(
  source: MediaSourceRecord,
  keyword: string,
  maxResults?: number,
): Promise<SourceSearchResult> {
  const base = {
    sourceId: source.id,
    sourceName: source.name,
    factory: source.factory,
  };

  try {
    return source.factory === SourceFactory.Rss
      ? await searchRss(source, keyword, maxResults, base)
      : await searchWebSelector(source, keyword, maxResults, base);
  } catch (error) {
    return {
      ...base,
      ok: false,
      error: describeFetchFailure(error),
      items: [],
      diagnostics: null,
      feedItems: [],
    };
  }
}

/** 把网络/安全错误翻译成用户能据以行动的中文说明。 */
function describeFetchFailure(error: unknown): string {
  if (error instanceof UnsafeUrlError) return `已拦截：${error.message}`;
  if (error instanceof FetchError) return error.message;
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "请求超时";
    return error.message;
  }
  return String(error);
}

async function searchWebSelector(
  source: MediaSourceRecord,
  keyword: string,
  maxResults: number | undefined,
  base: { sourceId: string; sourceName: string; factory: string },
): Promise<SourceSearchResult> {
  const config = source.config as WebSelectorConfig;
  const transformed = transformKeyword(keyword, config.keywordMode ?? KeywordMode.Raw);
  const url = expandTemplate(config.searchUrl, { keyword: transformed });

  await respectRateLimit(url, config.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS);

  const response = await fetchText(url, {
    headers: config.headers,
    acceptContentTypes: ["text/html", "application/xhtml", "text/plain"],
  });

  const baseUrl = deriveBaseUrl(config) ?? response.finalUrl;
  const extracted = extractSearchResults(response.body, config, baseUrl);

  return {
    ...base,
    ok: true,
    error: null,
    items: maxResults ? extracted.items.slice(0, maxResults) : extracted.items,
    diagnostics: extracted.diagnostics,
    feedItems: [],
  };
}

async function searchRss(
  source: MediaSourceRecord,
  keyword: string,
  maxResults: number | undefined,
  base: { sourceId: string; sourceName: string; factory: string },
): Promise<SourceSearchResult> {
  const config = source.config as RssConfig;
  const transformed = transformKeyword(keyword, config.keywordMode ?? KeywordMode.Raw);
  const url = expandTemplate(config.searchUrl, { keyword: transformed });

  await respectRateLimit(url, config.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS);

  const response = await fetchText(url, {
    headers: config.headers,
    acceptContentTypes: [
      "application/rss+xml",
      "application/atom+xml",
      "application/xml",
      "text/xml",
      "text/html",
      "text/plain",
    ],
  });

  const baseUrl = deriveBaseUrl(config) ?? response.finalUrl;
  let feedItems = parseFeed(response.body, baseUrl);
  feedItems = filterFeedItems(feedItems, config);

  return {
    ...base,
    ok: true,
    error: null,
    items: [],
    diagnostics: null,
    feedItems: maxResults ? feedItems.slice(0, maxResults) : feedItems,
  };
}

/**
 * 抓取条目详情页并提取剧集列表（仅 web-selector 有意义）。
 */
export async function fetchEpisodesFor(
  sourceId: string,
  detailUrl: string,
): Promise<{ ok: boolean; error: string | null; items: { name: string; url: string }[]; diagnostics: ExtractionDiagnostics | null }> {
  const source = await getSource(sourceId);
  if (!source) throw new Error("源不存在");

  const config = source.config as WebSelectorConfig;
  if (source.factory !== SourceFactory.WebSelector) {
    return { ok: false, error: "该源类型不支持提取剧集（RSS 源直接给出资源链接）", items: [], diagnostics: null };
  }

  try {
    await respectRateLimit(detailUrl, config.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS);
    const response = await fetchText(detailUrl, {
      headers: config.headers,
      acceptContentTypes: ["text/html", "application/xhtml", "text/plain"],
    });

    const baseUrl = deriveBaseUrl(config) ?? response.finalUrl;
    const extracted = extractEpisodes(response.body, config, baseUrl);
    return {
      ok: true,
      error: null,
      items: extracted.items.map((item) => ({ name: item.name, url: item.url })),
      diagnostics: extracted.diagnostics,
    };
  } catch (error) {
    return { ok: false, error: describeFetchFailure(error), items: [], diagnostics: null };
  }
}
