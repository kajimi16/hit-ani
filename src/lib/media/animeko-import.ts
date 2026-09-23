/**
 * Animeko `web-selector` v2 导出 → 站内源配置 的转换。
 *
 * 为什么要兼容这个格式：Animeko 的源配置生态已经很成熟（社区维护的订阅里
 * 有大量现成配置），重新发明一套只会让用户没法复用。
 * 转换而非直接使用，是因为两边的能力边界不同：
 *
 * | Animeko 有 | 站内有 | 处理 |
 * | --- | --- | --- |
 * | 5 步引擎（search→subjects→episodes→media→video） | 同样的链路 | 一一映射 |
 * | `subjectFormatId: a / indexed` | `searchMode: nested / parallel` | 一一映射 |
 * | `channelFormatId: index-grouped / no-channel` | 单个 CSS 选择器 | 拼成后代选择器 |
 * | `tier` / `channelTiers` 权重 | 无 | **丢弃**（站内不做多线路优选） |
 * | `matchVideoUrl` 正则 | `videoUrlPattern` | 一一映射 |
 *
 * ⚠️ 边界：`matchVideoUrl` 提取出的是**视频直链**，交给浏览器 `<video>` 直接播放，
 * 本平台不代理字节流（详见 docs/MEDIA.md §6.4）。
 */

import {
  KeywordMode,
  SearchMode,
  webSelectorConfigSchema,
  type KeywordModeValue,
  type WebSelectorConfigInput,
} from "./source-config";

/** Animeko 导出文件里单个源的形状（只声明我们读取的字段）。 */
export interface AnimekoSource {
  name: string;
  description?: string;
  searchUrl: string;
  searchUseOnlyFirstWord?: boolean;
  searchRemoveSpecial?: boolean;

  /** "a" = 条目元素自身即链接；"indexed" = 名字与链接是两个平行列表 */
  subjectFormatId?: "a" | "indexed";
  selectorSubjectFormatA?: { selectLists?: string };
  selectorSubjectFormatIndexed?: { selectNames?: string; selectLinks?: string };

  channelFormatId?: "index-grouped" | "no-channel";
  selectorChannelFormatFlattened?: {
    selectEpisodeLists?: string;
    selectEpisodesFromList?: string;
  };
  selectorChannelFormatNoChannel?: { selectEpisodes?: string };

  matchVideo?: {
    enableNestedUrl?: boolean;
    matchNestedUrl?: string;
    matchVideoUrl?: string;
    cookies?: string;
    addHeadersToVideo?: { referer?: string; userAgent?: string };
  };

  tier?: number;
}

export interface ConvertedSource {
  name: string;
  description: string | null;
  config: WebSelectorConfigInput;
  /** 转换过程中丢弃或调整了什么 —— 让用户知道能力差异 */
  notes: string[];
}

export class AnimekoImportError extends Error {
  constructor(
    message: string,
    readonly sourceName: string,
  ) {
    super(`「${sourceName}」${message}`);
    this.name = "AnimekoImportError";
  }
}

/** Animeko 用 `$^` 表示「该步骤禁用」（一个永不匹配的正则）。 */
function isDisabledPattern(pattern: string | undefined): boolean {
  return !pattern || pattern.trim() === "$^";
}

/**
 * 关键词处理模式。
 *
 * Animeko 允许同时开 `searchUseOnlyFirstWord` 与 `searchRemoveSpecial`，
 * 站内模型只支持一种 —— 取**更激进**的那个（先取首词、再去特殊字符），
 * 因为中文番剧名的完整标题在第三方站往往搜不到。
 */
function pickKeywordMode(source: AnimekoSource): KeywordModeValue {
  if (source.searchUseOnlyFirstWord) return KeywordMode.FirstWord;
  if (source.searchRemoveSpecial) return KeywordMode.StripSpecial;
  return KeywordMode.Raw;
}

/**
 * 剧集选择器。
 *
 * Animeko 把「剧集容器」与「容器内的条目」分成两级（因为一个页面上有多条线路，
 * 每条线路一个容器）。站内只用一个 CSS 选择器，因此拼成后代选择器 ——
 * 效果等价：一次性匹配所有线路下的所有剧集。
 */
function pickEpisodeSelector(source: AnimekoSource, notes: string[]): string | undefined {
  const grouped = source.selectorChannelFormatFlattened;
  if (source.channelFormatId === "index-grouped" && grouped?.selectEpisodeLists) {
    const item = grouped.selectEpisodesFromList?.trim();
    if (item) {
      notes.push("剧集选择器由「容器 + 条目」合并为后代选择器，多线路会自动合并");
      return `${grouped.selectEpisodeLists} ${item}`;
    }
    return grouped.selectEpisodeLists;
  }

  const flat = source.selectorChannelFormatNoChannel?.selectEpisodes;
  if (flat) return flat;

  // index-grouped 但缺字段时回退到 no-channel 形态
  if (grouped?.selectEpisodeLists) {
    notes.push("缺少 selectEpisodesFromList，直接使用剧集容器选择器");
    return grouped.selectEpisodesFromList
      ? `${grouped.selectEpisodeLists} ${grouped.selectEpisodesFromList}`
      : grouped.selectEpisodeLists;
  }

  return undefined;
}

/** 请求头：把 Animeko 的 video 头与 cookies 提成站内的 headers。 */
function pickHeaders(source: AnimekoSource, origin: string | null): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const ua = source.matchVideo?.addHeadersToVideo?.userAgent?.trim();
  if (ua) headers["User-Agent"] = ua;
  const cookies = source.matchVideo?.cookies?.trim();
  if (cookies) headers["Cookie"] = cookies;

  // 站内没有 Animeko 的 WebView 上下文，抓取时带上站点自身 Referer
  // 最接近浏览器内导航的行为 —— 部分站点不校验就不给内容。
  const referer = source.matchVideo?.addHeadersToVideo?.referer?.trim();
  if (referer) headers["Referer"] = referer;
  else if (origin) headers["Referer"] = origin;

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** 从搜索模板推导站点 origin（用于 Referer）。 */
function originOf(searchUrl: string): string | null {
  try {
    const url = new URL(searchUrl.replace(/\{[a-zA-Z]+\}/g, "x"));
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/**
 * 转换单个源。抛 `AnimekoImportError` 表示该源缺少必需字段。
 */
export function convertAnimekoSource(source: AnimekoSource): ConvertedSource {
  const notes: string[] = [];
  const name = source.name?.trim();
  if (!name) throw new AnimekoImportError("缺少 name", "(未命名)");
  if (!source.searchUrl?.trim()) throw new AnimekoImportError("缺少 searchUrl", name);

  const isParallel = source.subjectFormatId === "indexed";
  const origin = originOf(source.searchUrl);

  const config: WebSelectorConfigInput = {
    searchUrl: source.searchUrl.trim(),
    keywordMode: pickKeywordMode(source),
    searchMode: isParallel ? SearchMode.Parallel : SearchMode.Nested,
    headers: pickHeaders(source, origin),
  };

  if (isParallel) {
    const indexed = source.selectorSubjectFormatIndexed;
    if (!indexed?.selectNames || !indexed?.selectLinks) {
      throw new AnimekoImportError(
        "subjectFormatId 为 indexed 但缺少 selectNames/selectLinks",
        name,
      );
    }
    config.searchNameSelector = indexed.selectNames;
    config.searchLinkSelector = indexed.selectLinks;
    notes.push("名字与链接是平行列表，按下标对应");
  } else {
    const lists = source.selectorSubjectFormatA?.selectLists;
    if (!lists) {
      throw new AnimekoImportError("subjectFormatId 为 a 但缺少 selectLists", name);
    }
    config.searchItemSelector = lists;
    // 不设 searchNameSelector / searchLinkSelector：条目元素自身就是 <a>，
    // 用它的文本作名字、href 作链接（站内解析器已支持这个形态）
    notes.push("条目元素自身即链接，名字取其文本");
  }

  const episodeSelector = pickEpisodeSelector(source, notes);
  if (episodeSelector) {
    config.episodeItemSelector = episodeSelector;
  } else {
    notes.push("未提供剧集选择器：只能列出条目，无法展开到集");
  }

  const nested = source.matchVideo?.matchNestedUrl;
  if (!isDisabledPattern(nested)) {
    config.nestedUrlPattern = nested;
  }

  const video = source.matchVideo?.matchVideoUrl;
  if (!isDisabledPattern(video)) {
    config.videoUrlPattern = video;
  } else {
    notes.push("未提供视频地址正则：无法提取直链");
  }

  if (typeof source.tier === "number") {
    notes.push(`丢弃了 Animeko 的 tier=${source.tier} 权重（站内不做线路优选）`);
  }

  // 转换完立刻校验 —— 转换逻辑出错在这里就暴露，而不是等到用户点搜索
  const parsed = webSelectorConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new AnimekoImportError(
      `转换结果未通过校验：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      name,
    );
  }

  return {
    name,
    description: source.description?.trim() || null,
    config: parsed.data,
    notes,
  };
}

/** 批量转换，逐个报告成功与失败（不因一个源坏掉而全盘失败）。 */
export function convertAnimekoExport(payload: {
  sources: AnimekoSource[];
}): {
  converted: ConvertedSource[];
  failed: { name: string; reason: string }[];
} {
  const converted: ConvertedSource[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const source of payload.sources) {
    try {
      converted.push(convertAnimekoSource(source));
    } catch (error) {
      failed.push({
        name: source.name ?? "(未命名)",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { converted, failed };
}
