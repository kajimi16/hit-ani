/**
 * 源配置：数据模型、校验与 URL 模板。
 *
 * 借鉴 Animeko `SelectorSearchConfig` / `RssSearchConfig`（docs/MEDIA.md §2、§4），
 * 但**只保留实际会用到的字段**：Animeko 的 `subjectFormatId` 有 a/indexed/json-path-indexed
 * 三种形态、`channelFormatId` 有 no-channel/index-grouped —— 那是为兼容几十个真实站点
 * 长期演化出来的复杂度，校内自用平台不需要一上来就承担。
 *
 * 本模块**不含网络与 IO**，因此可以在没有外网的情况下完整测试。
 */

import { z } from "zod";

/** 源类型。对齐 Animeko 的 `factoryId`。 */
export const SourceFactory = {
  /** CSS 选择器抓取 HTML */
  WebSelector: "web-selector",
  /** RSS / Atom 订阅 */
  Rss: "rss",
} as const;

export type SourceFactoryValue = (typeof SourceFactory)[keyof typeof SourceFactory];

/**
 * 搜索关键词的处理方式。
 *
 * 为什么需要：中文番剧名常带空格、`～`、`！`、`?` 等字符，很多站点搜索会因此匹配失败。
 * Animeko 对应 `searchUseOnlyFirstWord` / `searchRemoveSpecial`。
 */
export const KeywordMode = {
  /** 原样使用 */
  Raw: "raw",
  /** 只取第一个词（空格分隔） */
  FirstWord: "first-word",
  /** 去掉特殊字符 */
  StripSpecial: "strip-special",
} as const;

export type KeywordModeValue = (typeof KeywordMode)[keyof typeof KeywordMode];

/** 单次请求间的间隔下限，避免打爆对方站点。 */
export const MIN_REQUEST_INTERVAL_MS = 500;
export const DEFAULT_REQUEST_INTERVAL_MS = 3000;

const headersSchema = z.record(z.string().max(64), z.string().max(1024));

/**
 * 搜索结果的两种 DOM 形态。Animeko 里对应 `subjectFormatId: "a" | "indexed"`。
 *
 * - `nested`：每个条目是一个容器元素，名字/链接在其中（或元素自身就是 `<a>`）
 * - `parallel`：名字与链接是**两个独立的列表**，按下标一一对应
 *   （很多 CMS 模板把标题和封面链接分开渲染，必须靠下标 zip）
 */
export const SearchMode = {
  Nested: "nested",
  Parallel: "parallel",
} as const;

export type SearchModeValue = (typeof SearchMode)[keyof typeof SearchMode];

export const webSelectorConfigSchema = z.object({
  /** 搜索地址模板，必须含 `{keyword}` */
  searchUrl: z.string().min(1).max(2048),
  keywordMode: z.enum([KeywordMode.Raw, KeywordMode.FirstWord, KeywordMode.StripSpecial]).default(KeywordMode.Raw),

  searchMode: z.enum([SearchMode.Nested, SearchMode.Parallel]).default(SearchMode.Nested),

  /** nested 模式：每个条目一个容器元素 */
  searchItemSelector: z.string().max(512).optional(),
  /**
   * nested 模式：相对条目元素取名字（取其文本）。
   * **省略表示用条目元素自身的文本** —— 条目元素本身就是 `<a>` 时（很常见）不需要再套一层。
   *
   * parallel 模式：绝对选择器，取整页的名字列表。
   */
  searchNameSelector: z.string().max(512).optional(),
  /** nested：相对条目元素取链接。省略则用元素自身（若是 `<a>`）或其中第一个 `<a>` */
  searchLinkSelector: z.string().max(512).optional(),

  /** 条目页：剧集列表项；省略表示搜索结果页直接给出可播放项 */
  episodeItemSelector: z.string().max(512).optional(),
  episodeNameSelector: z.string().max(512).optional(),
  episodeLinkSelector: z.string().max(512).optional(),

  /** 从播放页 HTML 里提取视频地址的正则；支持 `(?<v>...)` 命名分组 */
  videoUrlPattern: z.string().max(1024).optional(),
  /** 匹配嵌套跳转页地址的正则 */
  nestedUrlPattern: z.string().max(1024).optional(),

  /** 附加请求头（防盗链：Referer / User-Agent） */
  headers: headersSchema.optional(),
  /** 请求间隔，毫秒 */
  requestIntervalMs: z.number().int().min(MIN_REQUEST_INTERVAL_MS).max(60_000).default(DEFAULT_REQUEST_INTERVAL_MS),
  /** 基址；省略则从 `searchUrl` 推导，用于解析相对链接 */
  baseUrl: z.string().max(2048).optional(),
  /** 需要把页面里的 HTML 实体反转义后再匹配（部分站点会转义 &amp; 等） */
  unescapeHtml: z.boolean().default(true),
}).superRefine(refineSearchSelectors);

/** 按 searchMode 校验必填项 —— 存进去一个永远搜不到东西的配置比报错更糟。 */
function refineSearchSelectors(
  config: {
    searchMode: SearchModeValue;
    searchItemSelector?: string;
    searchNameSelector?: string;
    searchLinkSelector?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (config.searchMode === SearchMode.Nested) {
    if (!config.searchItemSelector) {
      ctx.addIssue({
        code: "custom",
        path: ["searchItemSelector"],
        message: "nested 模式必须提供条目选择器",
      });
    }
  } else {
    if (!config.searchNameSelector || !config.searchLinkSelector) {
      ctx.addIssue({
        code: "custom",
        path: ["searchNameSelector"],
        message: "parallel 模式必须同时提供名字与链接选择器（两个列表按下标对应）",
      });
    }
  }
}

export const rssConfigSchema = z.object({
  /** 订阅地址模板，含 `{keyword}`；含 `{page}` 时支持翻页 */
  searchUrl: z.string().min(1).max(2048),
  keywordMode: z.enum([KeywordMode.Raw, KeywordMode.FirstWord, KeywordMode.StripSpecial]).default(KeywordMode.Raw),
  headers: headersSchema.optional(),
  requestIntervalMs: z.number().int().min(MIN_REQUEST_INTERVAL_MS).max(60_000).default(DEFAULT_REQUEST_INTERVAL_MS),
  /** 只保留 enclosure/link 是种子或磁力的条目 */
  torrentOnly: z.boolean().default(false),
});

export const sourceConfigSchema = z.discriminatedUnion("factory", [
  z.object({ factory: z.literal(SourceFactory.WebSelector), config: webSelectorConfigSchema }),
  z.object({ factory: z.literal(SourceFactory.Rss), config: rssConfigSchema }),
]);

/** 解析**后**的配置（默认值已填充）—— 引擎内部使用。 */
export type WebSelectorConfig = z.infer<typeof webSelectorConfigSchema>;
export type RssConfig = z.infer<typeof rssConfigSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;

/**
 * 解析**前**的配置 —— 预设与 API 入参使用。
 * 有默认值的字段可以省略，因此不能复用上面的输出类型。
 */
export type WebSelectorConfigInput = z.input<typeof webSelectorConfigSchema>;
export type RssConfigInput = z.input<typeof rssConfigSchema>;

/* ------------------------------------------------------------------ *
 * 关键词处理与 URL 模板
 * ------------------------------------------------------------------ */

/**
 * 搜索站点通常无法正确处理的字符，替换为空格。
 *
 * 分组说明（按来源而非单列字符，便于日后增补）：
 * - ASCII 标点：`!-/` `:-@` `` [-` `` `{-~`
 * - 全角标点：U+FF01–FF0F、FF1A–FF20、FF3B–FF40、FF5B–FF5E
 * - CJK 标点与符号：U+3000–303F、U+30FB
 * - 装饰符号：番剧标题高频出现（「魔法少女☆小圆」「Re:Zero ♪」），
 *   不剥离会导致这类标题在多数站点搜不到
 *
 * 保留：中日文字符、字母、数字、空格。
 */
const SPECIAL_CHARS =
  /[!-/:-@[-`{-~\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF5E\u3000-\u303F\u30FB\u2018\u2019\u201C\u201D\u2605\u2606\u266A\u266B\u2665\u2666\u25CF\u25CB\u25C6\u25C7\u25A0\u25A1\u25B2\u25B3\u25BC\u25BD\u203B\u2020\u2021\u00B7]/g;

export function stripSpecialChars(keyword: string): string {
  return keyword.replace(SPECIAL_CHARS, " ").replace(/\s+/g, " ").trim();
}

/** 应用关键词处理模式。 */
export function transformKeyword(keyword: string, mode: KeywordModeValue): string {
  const trimmed = keyword.trim();
  switch (mode) {
    case KeywordMode.FirstWord: {
      const first = trimmed.split(/\s+/)[0] ?? "";
      return first.length > 0 ? first : trimmed;
    }
    case KeywordMode.StripSpecial: {
      const stripped = stripSpecialChars(trimmed);
      return stripped.length > 0 ? stripped : trimmed;
    }
    case KeywordMode.Raw:
      return trimmed;
  }
}

/**
 * 把模板里的 `{keyword}` / `{word}` / `{page}` 展开。
 *
 * 编码策略：`{keyword}` 与 `{word}` 都做 URL 编码（搜索词常含中日文与空格）；
 * `{page}` 是数字，直接内插。模板里若已把占位符写在 query 中（`?q={keyword}`），
 * 这里编码后即为正确结果。
 */
export function expandTemplate(
  template: string,
  params: { keyword: string; page?: number },
): string {
  let result = template.replace(/\{(keyword|word)\}/g, encodeURIComponent(params.keyword));
  if (params.page !== undefined) {
    result = result.replace(/\{page\}/g, String(params.page));
  }
  return result;
}

/** 模板是否含关键词占位符 —— 不含的话搜索永远返回同一页，属于配置错误。 */
export function hasKeywordPlaceholder(template: string): boolean {
  return /\{(keyword|word)\}/.test(template);
}

/** 是否支持翻页。 */
export function hasPagePlaceholder(template: string): boolean {
  return /\{page\}/.test(template);
}

/**
 * 从搜索模板推导基址，用于把相对链接解析成绝对 URL。
 * 显式配置了 `baseUrl` 时优先用它。
 */
export function deriveBaseUrl(config: { searchUrl: string; baseUrl?: string }): string | null {
  if (config.baseUrl) return config.baseUrl;
  try {
    // 模板里的占位符会让 URL 解析失败，先替换成占位值
    const probe = config.searchUrl.replace(/\{[a-zA-Z]+\}/g, "x");
    const url = new URL(probe);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 预设
 * ------------------------------------------------------------------ */

export interface SourcePreset {
  id: string;
  name: string;
  description: string;
  factory: SourceFactoryValue;
  config: WebSelectorConfigInput | RssConfigInput;
  /** 使用该预设时的注意事项 */
  notes: string;
}

/**
 * 内置预设。
 *
 * ⚠️ 这些是**模板起点**，不是「开箱即用」的源：
 * RSS 端点是公开的（dmhy / mikan 的订阅地址），但站点结构与可用性会变，
 * 需要在校内环境实测后再启用。CSS 选择器类站点更是不保证长期有效。
 */
export const SOURCE_PRESETS: readonly SourcePreset[] = [
  {
    id: "dmhy-rss",
    name: "动漫花园（RSS）",
    description: "按关键词搜索动漫花园的 RSS 订阅",
    factory: SourceFactory.Rss,
    config: {
      searchUrl: "https://share.dmhy.org/topics/rss/rss.xml?keyword={keyword}",
      keywordMode: KeywordMode.FirstWord,
      requestIntervalMs: 3000,
      torrentOnly: true,
    },
    notes: "公开 RSS 端点。返回磁力/种子链接，需外部 BT 客户端消费；站点若变更路径会失效。",
  },
  {
    id: "mikan-rss",
    name: "蜜柑计划（RSS 搜索）",
    description: "按关键词搜索蜜柑计划的 RSS 订阅",
    factory: SourceFactory.Rss,
    config: {
      searchUrl: "https://mikanani.me/RSS/Search?searchstr={keyword}",
      keywordMode: KeywordMode.FirstWord,
      requestIntervalMs: 3000,
      torrentOnly: true,
    },
    notes: "公开 RSS 端点。同名站点有多个镜像域名，需按实际可达性选择。",
  },
  {
    id: "bahamut-anime",
    name: "巴哈姆特動畫瘋（正版流媒体）",
    description: "台湾正版授权流媒体，免费含广告。给的是**播放页链接，点开就能看**",
    factory: SourceFactory.WebSelector,
    config: {
      // 必须带 ajax=1 —— 不带时搜索结果是 JS 渲染的，抓不到
      searchUrl: "https://ani.gamer.com.tw/search.php?keyword={keyword}&ajax=1",
      keywordMode: KeywordMode.Raw,
      searchItemSelector: ".animate-theme-list .theme-list-block a.theme-list-main",
      searchNameSelector: "p.theme-name",
      baseUrl: "https://ani.gamer.com.tw",
      requestIntervalMs: 3000,
      // 站点校验来源，不带 Referer 可能被拒
      headers: { Referer: "https://ani.gamer.com.tw/" },
    },
    notes:
      "正版授权，链接指向官方播放页 —— 点开即看，无需下载。⚠️ 仅限台湾地区 IP 观看，其他地区打开会提示区域限制。",
  },
];
