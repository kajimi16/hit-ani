/**
 * HTML / RSS 提取 —— 纯函数，只吃字符串、吐结构化数据。
 *
 * 与网络层（`fetcher.ts`）严格分离，因此可以用固定 fixture 完整测试，
 * 不依赖外网站点是否可达、结构是否变更。这是本模块最重要的设计取舍：
 * **解析逻辑必须能在离线状态下被验证**，否则站点一变就无从判断是哪一层坏了。
 *
 * 借鉴 Animeko `SelectorMediaSource` 的做法（CSS selector 抓取），用 cheerio 而非 Jsoup。
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { SearchMode, type RssConfig, type WebSelectorConfig } from "./source-config";
import { resolveUrl } from "./url-safety";

/** 提取出的搜索条目。 */
export interface SearchResultItem {
  name: string;
  /** 条目详情页绝对 URL */
  url: string;
  /** 原始 href（保留以便调试） */
  rawHref: string;
}

/** 提取出的剧集 / 资源项。 */
export interface ExtractedEpisode {
  name: string;
  url: string;
  rawHref: string;
}

/** 提取诊断 —— 让「为什么没抓到」可回答，而不是只返回空数组。 */
export interface ExtractionDiagnostics {
  /** 选择器命中的元素数；0 通常意味着选择器写错了 */
  matchedElements: number;
  /** 被丢弃的条目及原因 */
  dropped: { reason: string; sample: string }[];
  /** 解析相对链接所用的基址 */
  baseUrl: string | null;
}

export interface ExtractionResult<T> {
  items: T[];
  diagnostics: ExtractionDiagnostics;
}

/**
 * 反转义 HTML 实体。
 * 部分站点把链接写成 `&amp;` 形式，直接在原文里正则提链会漏掉 query 参数。
 */
export function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** 取元素链接：优先 `href`，回退常见 data 属性。 */
function hrefOf(element: cheerio.Cheerio<AnyNode>): string {
  for (const attribute of ["href", "data-href", "data-url", "data-src"]) {
    const value = (element.attr(attribute) ?? "").trim();
    if (value.length > 0) return value;
  }
  return "";
}

/**
 * 定位元素的链接。
 *
 * 查找顺序：显式选择器 → 元素自身是 `<a>` → 元素内第一个 `<a>`。
 * 对「整块是链接」与「只有标题是链接」两种站点结构都能工作 ——
 * 强制要求某一种会让一半站点配不出来。
 */
function findHref(
  node: cheerio.Cheerio<AnyNode>,
  selector: string | undefined,
  selfIsAnchor: boolean,
): string {
  if (selector) {
    const explicit = hrefOf(node.find(selector).first());
    if (explicit.length > 0) return explicit;
  }
  // 元素自身就是 <a>：直接取其 href
  if (selfIsAnchor) {
    const self = hrefOf(node);
    if (self.length > 0) return self;
  }
  return hrefOf(node.find("a").first());
}

/**
 * 从搜索结果页提取条目。
 *
 * 支持两种 DOM 形态（见 `SearchMode`）：
 * - `nested`：逐条目在容器内查找名字与链接
 * - `parallel`：名字与链接是两个独立列表，按下标 zip
 *
 * 名字选择器省略时用**元素自身的文本** —— 条目元素本身就是 `<a>` 时很常见。
 */
export function extractSearchResults(
  html: string,
  config: WebSelectorConfig,
  baseUrl: string | null,
): ExtractionResult<SearchResultItem> {
  const source = config.unescapeHtml ? unescapeHtmlEntities(html) : html;
  const $ = cheerio.load(source);

  const dropped: { reason: string; sample: string }[] = [];
  const items: SearchResultItem[] = [];

  const push = (name: string, href: string, sample: string): void => {
    if (name.length === 0) {
      dropped.push({ reason: "条目名为空（searchNameSelector 可能写错）", sample });
      return;
    }
    if (href.length === 0) {
      dropped.push({ reason: "未找到链接（searchLinkSelector 可能写错）", sample });
      return;
    }
    const url = resolveUrl(href, baseUrl ?? "");
    if (url === null) {
      dropped.push({ reason: "相对链接无法解析（缺少 baseUrl？）", sample: href });
      return;
    }
    items.push({ name, url, rawHref: href });
  };

  if (config.searchMode === SearchMode.Parallel) {
    // 名字与链接是两份独立列表，靠下标对应。
    // 只用较短的那个长度 —— 长度不一致说明页面结构变了，
    // 强行配对的另一半一定是错的。
    const nameNodes = $(config.searchNameSelector ?? "");
    const linkNodes = $(config.searchLinkSelector ?? "");
    const matchedElements = nameNodes.length;
    const pairCount = Math.min(nameNodes.length, linkNodes.length);

    if (nameNodes.length !== linkNodes.length) {
      dropped.push({
        reason: `名字与链接数量不一致（${nameNodes.length} vs ${linkNodes.length}），只取前 ${pairCount} 组`,
        sample: "",
      });
    }

    for (let i = 0; i < pairCount; i += 1) {
      const name = nameNodes.eq(i).text().trim();
      const href = hrefOf(linkNodes.eq(i));
      push(name, href, name.slice(0, 40) || href.slice(0, 40));
    }

    return { items, diagnostics: { matchedElements, dropped, baseUrl } };
  }

  const elements = $(config.searchItemSelector ?? "");
  const matchedElements = elements.length;

  elements.each((_index, element) => {
    const node = $(element);
    // 未配置名字选择器 → 用元素自身文本（条目元素本身就是 <a> 的常见形态）
    const name = config.searchNameSelector
      ? node.find(config.searchNameSelector).first().text().trim()
      : node.text().trim();
    const href = findHref(node, undefined, tagNameOf(element) === "a");
    push(name, href, name.slice(0, 40) || href.slice(0, 40));
  });

  return { items, diagnostics: { matchedElements, dropped, baseUrl } };
}

/** 从条目详情页提取剧集列表。未配置剧集选择器时返回空数组（不是错误）。 */
export function extractEpisodes(
  html: string,
  config: WebSelectorConfig,
  baseUrl: string | null,
): ExtractionResult<ExtractedEpisode> {
  const source = config.unescapeHtml ? unescapeHtmlEntities(html) : html;
  const $ = cheerio.load(source);

  const dropped: { reason: string; sample: string }[] = [];
  const items: ExtractedEpisode[] = [];

  if (!config.episodeItemSelector) {
    return { items, diagnostics: { matchedElements: 0, dropped, baseUrl } };
  }

  const elements = $(config.episodeItemSelector);
  const matchedElements = elements.length;

  elements.each((_index, element) => {
    const node = $(element);
    const name = config.episodeNameSelector
      ? node.find(config.episodeNameSelector).first().text().trim()
      : node.text().trim();
    const href = findHref(node, config.episodeLinkSelector, tagNameOf(element) === "a");
    const sample = name.slice(0, 40) || node.text().trim().slice(0, 40);

    if (href.length === 0) {
      dropped.push({ reason: "剧集缺少链接", sample });
      return;
    }

    const url = resolveUrl(href, baseUrl ?? "");
    if (url === null) {
      dropped.push({ reason: "剧集相对链接无法解析", sample: href });
      return;
    }

    items.push({ name: name || url, url, rawHref: href });
  });

  return { items, diagnostics: { matchedElements, dropped, baseUrl } };
}

/**
 * 归一化内嵌配置里的转义，供视频地址匹配。
 *
 * **这是实测踩出来的**：绝大多数 CMS（MacCMS 系）把播放地址塞在
 * `player_aaaa={"url":"https:\/\/play.example.com\/...\/index.m3u8"}` 里 ——
 * 斜杠是 **JSON 转义**的。直接用 `https://` 去匹配永远找不到，
 * 而作者在浏览器里看页面时地址早已被解析，所以这个坑很难从现象上看出来。
 *
 * 处理三种转义：
 * - JSON 斜杠转义 `\/` → `/`（最常见的坑）
 * - Unicode 转义 `\uXXXX` → 真实字符（部分站点用它藏中文/特殊字符）
 * - HTML 实体 `&amp;` → `&`（query 参数会被截断）
 */
export function normalizeForVideoMatch(text: string): string {
  return (
    unescapeHtmlEntities(text)
      // Unicode 转义：\u9b54\u6cd5 → 魔法
      .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      )
      // JSON 斜杠转义：https:\/\/a.com → https://a.com
      .replace(/\\\//g, "/")
  );
}

/**
 * 找出文本中的所有 URL 候选。
 *
 * 正则终止于空白、引号、尖括号、反斜杠、右括号 —— 这些都不会出现在合法 URL 里，
 * 但一定会出现在 HTML 属性分隔与 JSON 结构上。
 */
export function findUrlCandidates(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>\\)]+/g) ?? [];
}

/**
 * 从播放页 HTML 提取真实视频地址。
 *
 * **关键语义**：Animeko 的 `matchVideoUrl` 是用来测试**单个候选 URL** 的
 * （它的候选来自 WebView 的网络拦截，每个本身就是一条完整 URL），
 * 因此那些正则普遍带 `^` 锚点。若直接拿它匹配整篇 HTML，
 * `^` 永远对不上 —— 地址明明在页面里却提取不出来。
 *
 * 所以这里先抽候选 URL、再逐个测试，与 Animeko 的语义一致。
 * 失败后才退回整篇匹配（兼容不含 `^` 的正则）。
 */
export function extractVideoUrl(html: string, pattern: string): string | null {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return null;
  }

  const source = normalizeForVideoMatch(html);

  // 1) 主要路径：抽候选 URL 逐个测试（Animeko 语义）
  for (const candidate of findUrlCandidates(source)) {
    const match = regex.exec(candidate);
    if (match) {
      const named = match.groups?.v ?? match.groups?.url ?? match.groups?.m3u8;
      const value = (named ?? match[0]).trim();
      if (value.length > 0) return value;
    }
  }

  // 2) 兜底：整篇匹配（不含 `^` 的正则，如「含 akamaized 的行」）
  const whole = regex.exec(source);
  if (whole) {
    const named = whole.groups?.v ?? whole.groups?.url ?? whole.groups?.m3u8;
    const value = (named ?? whole[0]).trim();
    if (value.length > 0) return value;
  }

  return null;
}

/** 匹配嵌套跳转页地址（播放页里的中间页）。 */
export function extractNestedUrl(html: string, pattern: string): string | null {
  return extractVideoUrl(html, pattern);
}

/* ------------------------------------------------------------------ *
 * RSS / Atom
 * ------------------------------------------------------------------ */

export interface RssItem {
  title: string;
  /** 资源链接：优先 enclosure（种子），回退 link */
  url: string;
  /** 条目页面链接 */
  link: string | null;
  publishedTime: number;
  sizeBytes: number | null;
}

/** 解析 RSS 2.0 与 Atom。两者元素名不同，这里都支持。 */
export function parseFeed(xml: string, baseUrl: string | null): RssItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];

  const nodes = $("item").length > 0 ? $("item") : $("entry");

  nodes.each((_index, element) => {
    const node = $(element);
    const title = node.find("title").first().text().trim();
    if (title.length === 0) return;

    // RSS 2.0：<enclosure url="...">
    let resourceUrl = node.find("enclosure").first().attr("url")?.trim() ?? "";

    // Atom：<link rel="enclosure" href="...">
    if (resourceUrl.length === 0) {
      node.find("link").each((_i, link) => {
        if (resourceUrl.length > 0) return;
        if ($(link).attr("rel") === "enclosure") {
          resourceUrl = ($(link).attr("href") ?? "").trim();
        }
      });
    }

    // 回退到第一个 link（RSS 用元素文本，Atom 用 href 属性）
    const firstLink = node.find("link").first();
    const link = firstLink.text().trim() || (firstLink.attr("href") ?? "").trim() || null;

    if (resourceUrl.length === 0) resourceUrl = link ?? "";

    const resolved = resolveUrl(resourceUrl, baseUrl ?? "");
    if (resolved === null) return;

    const rawDate =
      node.find("pubDate").first().text().trim() ||
      node.find("published").first().text().trim() ||
      node.find("updated").first().text().trim();
    const parsed = Date.parse(rawDate);

    const lengthAttr = node.find("enclosure").first().attr("length");
    const sizeBytes = lengthAttr ? Number(lengthAttr) : Number.NaN;

    items.push({
      title,
      url: resolved,
      link: link ? resolveUrl(link, baseUrl ?? "") : null,
      publishedTime: Number.isFinite(parsed) ? parsed : 0,
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
    });
  });

  return items;
}

/** 安全取节点标签名（`AnyNode` 含 Document，无 tagName）。 */
function tagNameOf(node: AnyNode): string | undefined {
  return "tagName" in node && typeof node.tagName === "string" ? node.tagName : undefined;
}

/** 判断链接是否为种子/磁力 —— `torrentOnly` 过滤用。 */
export function isTorrentLink(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.startsWith("magnet:") || lower.includes(".torrent");
}

/** 按 `torrentOnly` 过滤 RSS 条目。 */
export function filterFeedItems(items: RssItem[], config: RssConfig): RssItem[] {
  if (!config.torrentOnly) return items;
  return items.filter((item) => isTorrentLink(item.url));
}

/* ------------------------------------------------------------------ *
 * 集号解析
 * ------------------------------------------------------------------ */

/**
 * 从资源标题里解析集号。
 *
 * 为什么需要：BT/RSS 的条目名形如
 * `[字幕组] 某番 第11话 [1080p][简繁]` 或 `[Group] Show - 11 [1080p]`，
 * 而 BGM 的集是按 `ep`/`sort` 编号的。把标题里的集号解出来，
 * 用户才能「在 BGM 第 11 集旁边看到对应的资源」，而不是面对一堆散乱标题。
 *
 * 返回 null 表示无法确定集号 —— 调用方应把它归入「合集/未知」而不是瞎猜。
 * 宁可归入未知，也不要把「第 1-12 集合集」错标成第 1 集。
 */
export function extractEpisodeNumber(title: string): number | null {
  // ---- 第一轮：先排除合集 ----
  //
  // 合集被误判成单集是最糟的错误：用户会以为那个种子只有一集。
  // 除了「合集/全集」字样，还要覆盖区间写法 —— `TV 01-26Fin+SP`、
  // `[01-12先行版]`、`01-26Fin` 都是整季包，不带任何「合集」二字。
  if (/(合集|全集|全\d+[话集]|\bcomplete\b|\bFin\b|\d+\s*[-~]\s*\d+)/i.test(title)) {
    return null;
  }

  // ---- 第二轮：中日常见写法「第N话/集/話」----
  // 可信度最高，因为它有明确语义标记，不会与年份/分辨率混淆。
  const cnMatch = /第\s*(\d{1,4})\s*[话話集]/.exec(title);
  if (cnMatch) return Number(cnMatch[1]);

  // ---- 第三轮：方括号里**纯粹**是数字（最可靠的编号形式）----
  // `[11]`、`[01]`、`[11v2]`。必须放在「数字+后缀」之前，
  // 否则 `[7月新番][11]` 这种会把 7 当成集号。
  const strictBracket = /\[(\d{1,4})(?:v\d+)?\]/.exec(title);
  if (strictBracket) return Number(strictBracket[1]);

  // ---- 第四轮：方括号里是「数字 + 后缀」----
  // 例：`[07先行版]`、`[11话]`。
  //
  // 用否定环视排掉两类非集号：
  // - 分辨率/位深：`[1080p]`、`[10bits]`、`[1920x1080]` → p/x/b 开头
  // - 日期：`[7月新番]`、`[2020年]` → 月/年/日 开头
  // 不排掉它们的话，`[7月新番]` 会被当成第 7 集。
  const looseBracket = /\[(\d{1,4})(?!\d*[pPxXbB月年日])[^\]]*\]/.exec(title);
  if (looseBracket) return Number(looseBracket[1]);

  // ---- 第五轮：带前缀的西式写法 EP11 / E11 ----
  const prefixedMatch = /(?:^|[\s\-_.])(?:EP?|E)\s*(\d{1,4})(?:v\d+)?(?:[\s\-_.]|$)/i.exec(title);
  if (prefixedMatch) return Number(prefixedMatch[1]);

  // ---- 第六轮：裸数字跟在分隔符后（`Show - 11`）----
  //
  // 限制 1-3 位并要求前面是分隔符，避开 `(2015)` 年份与 `[1080p]` 分辨率
  // （它们的前一个字符分别是 `(` 和 `[`，都不在分隔符集合里）。
  const bareMatch = /[\s\-_.](\d{1,3})(?:v\d+)?(?:[\s\-_.\]]|$)/.exec(title);
  if (bareMatch) return Number(bareMatch[1]);

  // 无法判定时返回 null，归入「合集/未知」—— 宁可让用户多点一次，
  // 也不要把资源挂到错误的集上。
  return null;
}

/**
 * 从资源标题里粗略估计体积（用于展示，解析失败返回 null）。
 *
 * 除数值+单位，还要处理 `1080x1920` 这类**尺寸**不会被误匹配 —— 它们没有单位后缀。
 */
export function extractSizeBytes(title: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(GB|GiB|MB|MiB|KB|KiB)\b/i.exec(title);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith("g")
    ? 1024 ** 3
    : unit.startsWith("m")
      ? 1024 ** 2
      : 1024;
  return Math.round(value * factor);
}
