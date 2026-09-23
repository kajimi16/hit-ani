/**
 * HTML / RSS 提取单测 —— 用固定 fixture，不依赖外网。
 *
 * 这是本模块最重要的测试：解析逻辑必须能在**离线**状态下被验证。
 * 否则第三方站点一改结构，就无从判断是「网络层挂了」还是「选择器过期了」。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractEpisodes,
  extractSearchResults,
  extractVideoUrl,
  filterFeedItems,
  isTorrentLink,
  parseFeed,
  unescapeHtmlEntities,
} from "@/lib/media/extract";
import { KeywordMode, webSelectorConfigSchema } from "@/lib/media/source-config";

const BASE = "https://anime.example.com";

/** 造一个合法的 web-selector 配置（补全 zod 默认值）。 */
function config(overrides: Record<string, unknown> = {}) {
  return webSelectorConfigSchema.parse({
    searchUrl: "https://anime.example.com/search?q={keyword}",
    searchItemSelector: ".result-item",
    searchNameSelector: ".title",
    searchLinkSelector: "a.detail",
    ...overrides,
  });
}

/* ---------------------------------------------------------------- *
 * 搜索页提取
 * ---------------------------------------------------------------- */

test("extractSearchResults 提取名称与绝对链接", () => {
  const html = `
    <div class="result-item">
      <a class="detail" href="/anime/1"><span class="title">反叛的鲁路修</span></a>
    </div>
    <div class="result-item">
      <a class="detail" href="/anime/2"><span class="title">钢之炼金术师</span></a>
    </div>`;

  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map((item) => item.name),
    ["反叛的鲁路修", "钢之炼金术师"],
  );
  assert.deepEqual(
    result.items.map((item) => item.url),
    ["https://anime.example.com/anime/1", "https://anime.example.com/anime/2"],
  );
  assert.equal(result.diagnostics.matchedElements, 2);
  assert.equal(result.diagnostics.dropped.length, 0);
});

test("extractSearchResults 选择器命中 0 时给出诊断而非静默空数组", () => {
  const html = `<div class="totally-different"><span>x</span></div>`;
  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.matchedElements, 0, "应报告命中数为 0，便于定位选择器问题");
});

test("extractSearchResults 条目名为空时丢弃并记录原因", () => {
  const html = `
    <div class="result-item"><a class="detail" href="/a"><span class="title"></span></a></div>
    <div class="result-item"><a class="detail" href="/b"><span class="title">有效</span></a></div>`;
  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, "有效");
  assert.match(result.diagnostics.dropped[0].reason, /条目名为空/);
});

test("extractSearchResults 缺链接时丢弃并记录原因", () => {
  const html = `<div class="result-item"><span class="title">没有链接</span></div>`;
  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items.length, 0);
  assert.match(result.diagnostics.dropped[0].reason, /未找到链接/);
});

test("extractSearchResults 在缺少 baseUrl 时丢弃相对链接（而不是产出坏 URL）", () => {
  const html = `<div class="result-item"><a class="detail" href="/x"><span class="title">T</span></a></div>`;
  const result = extractSearchResults(html, config(), null);
  assert.equal(result.items.length, 0);
  assert.match(result.diagnostics.dropped[0].reason, /baseUrl/);
});

test("extractSearchResults 支持「条目元素自身就是 <a>」的站点结构", () => {
  const html = `<a class="result-item" href="/y"><span class="title">自身是链接</span></a>`;
  const result = extractSearchResults(
    html,
    config({ searchLinkSelector: undefined }),
    BASE,
  );
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://anime.example.com/y");
});

test("extractSearchResults 在未配置链接选择器时回退到元素内第一个 <a>", () => {
  const html = `<li class="result-item"><span class="title">T</span><a href="/z">详情</a></li>`;
  const result = extractSearchResults(
    html,
    config({ searchItemSelector: "li", searchLinkSelector: undefined }),
    BASE,
  );
  assert.equal(result.items[0].url, "https://anime.example.com/z");
});

test("extractSearchResults 反转义 HTML 实体后再提取（&amp; 场景）", () => {
  const html = `<div class="result-item"><a class="detail" href="/x?id=1&amp;t=2"><span class="title">T</span></a></div>`;
  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items[0].url, "https://anime.example.com/x?id=1&t=2");
});

test("extractSearchResults 保留 rawHref 便于调试", () => {
  const html = `<div class="result-item"><a class="detail" href="/raw"><span class="title">T</span></a></div>`;
  const result = extractSearchResults(html, config(), BASE);
  assert.equal(result.items[0].rawHref, "/raw");
});

/* ---------------------------------------------------------------- *
 * 剧集提取
 * ---------------------------------------------------------------- */

test("extractEpisodes 未配置剧集选择器时返回空（非错误）", () => {
  const result = extractEpisodes("<html></html>", config(), BASE);
  assert.equal(result.items.length, 0);
  assert.equal(result.diagnostics.matchedElements, 0);
});

test("extractEpisodes 提取剧集名与链接", () => {
  const html = `
    <ul class="eps">
      <li><a href="/play/1">第 1 话</a></li>
      <li><a href="/play/2">第 2 话</a></li>
    </ul>`;
  const result = extractEpisodes(
    html,
    config({ episodeItemSelector: ".eps li" }),
    BASE,
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, "第 1 话");
  assert.equal(result.items[0].url, "https://anime.example.com/play/1");
});

/* ---------------------------------------------------------------- *
 * 视频地址提取
 * ---------------------------------------------------------------- */

test("extractVideoUrl 支持命名分组 (?<v>...)", () => {
  const html = `<script>var url = "https://cdn.example.com/video/abc.m3u8";</script>`;
  assert.equal(
    extractVideoUrl(html, 'url = "(?<v>https://[^"]+\\.m3u8)"'),
    "https://cdn.example.com/video/abc.m3u8",
  );
});

test("extractVideoUrl 无命名分组时取整个匹配", () => {
  const html = `<source src="https://cdn.example.com/a.mp4">`;
  assert.equal(extractVideoUrl(html, "https://[^\"']+\\.mp4"), "https://cdn.example.com/a.mp4");
});

test("extractVideoUrl 反转义后匹配（&amp; 参数场景）", () => {
  const html = `<script>src="https://cdn.example.com/v.m3u8?token=a&amp;b=c"</script>`;
  assert.equal(
    extractVideoUrl(html, '(?<v>https://[^"]+\\.m3u8\\?[^"]*)'),
    "https://cdn.example.com/v.m3u8?token=a&b=c",
  );
});

test("extractVideoUrl 对无匹配/非法正则返回 null（不抛异常）", () => {
  assert.equal(extractVideoUrl("<html></html>", "never-matches-xyz"), null);
  assert.equal(extractVideoUrl("<html></html>", "([unclosed"), null);
});

test("extractVideoUrl 支持 url / m3u8 命名分组别名", () => {
  const html = `<script>var u="https://x.com/a.m3u8";</script>`;
  assert.equal(extractVideoUrl(html, 'u="(?<url>[^"]+)"'), "https://x.com/a.m3u8");
  assert.equal(extractVideoUrl(html, 'u="(?<m3u8>[^"]+)"'), "https://x.com/a.m3u8");
});

/* ---------------------------------------------------------------- *
 * RSS / Atom
 * ---------------------------------------------------------------- */

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>测试源</title>
    <item>
      <title>[字幕组] 反叛的鲁路修 第01话 [1080P][简繁内封]</title>
      <link>https://anime.example.com/topic/100</link>
      <enclosure url="https://anime.example.com/torrent/100.torrent" length="734003200" type="application/x-bittorrent"/>
      <pubDate>Tue, 01 Oct 2024 12:00:00 +0800</pubDate>
    </item>
    <item>
      <title>[字幕组] 反叛的鲁路修 第02话 [1080P]</title>
      <link>https://anime.example.com/topic/101</link>
      <enclosure url="magnet:?xt=urn:btih:abcdef0123456789" length="734003200" type="application/x-bittorrent"/>
      <pubDate>Wed, 02 Oct 2024 12:00:00 +0800</pubDate>
    </item>
  </channel>
</rss>`;

test("parseFeed 解析 RSS 2.0：标题、enclosure、日期、大小", () => {
  const items = parseFeed(RSS_FIXTURE, BASE);
  assert.equal(items.length, 2);
  assert.match(items[0].title, /第01话/);
  assert.equal(items[0].url, "https://anime.example.com/torrent/100.torrent");
  assert.equal(items[0].sizeBytes, 734003200);
  assert.ok(items[0].publishedTime > 0, "应解析出发布时间");
  assert.equal(items[0].link, "https://anime.example.com/topic/100");
});

test("parseFeed 保留磁力链接不被当作相对路径", () => {
  const items = parseFeed(RSS_FIXTURE, BASE);
  assert.ok(items[1].url.startsWith("magnet:?"), `实际：${items[1].url}`);
});

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 测试源</title>
  <entry>
    <title>某番 第03话</title>
    <link rel="enclosure" href="https://anime.example.com/t/200.torrent" type="application/x-bittorrent"/>
    <link rel="alternate" href="https://anime.example.com/e/200"/>
    <updated>2024-10-03T12:00:00Z</updated>
  </entry>
</feed>`;

test("parseFeed 解析 Atom：rel=enclosure 的 href", () => {
  const items = parseFeed(ATOM_FIXTURE, BASE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "某番 第03话");
  assert.equal(items[0].url, "https://anime.example.com/t/200.torrent");
});

test("parseFeed 对空/畸形 XML 返回空数组（不抛异常）", () => {
  assert.deepEqual(parseFeed("", BASE), []);
  assert.deepEqual(parseFeed("<not-xml", BASE), []);
  assert.deepEqual(parseFeed("<rss><channel></channel></rss>", BASE), []);
});

test("parseFeed 跳过无标题条目", () => {
  const xml = `<rss><channel><item><link>https://a.com/1</link></item></channel></rss>`;
  assert.deepEqual(parseFeed(xml, BASE), []);
});

test("isTorrentLink 识别磁力与 .torrent", () => {
  assert.equal(isTorrentLink("magnet:?xt=urn:btih:abc"), true);
  assert.equal(isTorrentLink("https://x.com/a.torrent"), true);
  assert.equal(isTorrentLink("https://x.com/a.torrent?token=1"), true);
  assert.equal(isTorrentLink("https://x.com/a.mp4"), false);
  assert.equal(isTorrentLink("https://x.com/page"), false);
});

test("filterFeedItems 按 torrentOnly 过滤", () => {
  const items = parseFeed(RSS_FIXTURE, BASE);
  assert.equal(filterFeedItems(items, { torrentOnly: false } as never).length, 2);
  assert.equal(filterFeedItems(items, { torrentOnly: true } as never).length, 2);
});

/* ---------------------------------------------------------------- *
 * 实体反转义
 * ---------------------------------------------------------------- */

test("unescapeHtmlEntities 处理常见实体", () => {
  assert.equal(unescapeHtmlEntities("a&amp;b"), "a&b");
  assert.equal(unescapeHtmlEntities("&lt;tag&gt;"), "<tag>");
  assert.equal(unescapeHtmlEntities("&quot;x&quot;"), '"x"');
  assert.equal(unescapeHtmlEntities("&#39;y&#39;"), "'y'");
  assert.equal(unescapeHtmlEntities("a&nbsp;b"), "a b");
});

/* ---------------------------------------------------------------- *
 * 配置校验
 * ---------------------------------------------------------------- */

test("webSelectorConfigSchema 补全默认值", () => {
  const parsed = webSelectorConfigSchema.parse({
    searchUrl: "https://x.com/s?q={keyword}",
    searchItemSelector: ".i",
    searchNameSelector: ".n",
  });
  assert.equal(parsed.keywordMode, KeywordMode.Raw);
  assert.equal(parsed.unescapeHtml, true);
  assert.equal(parsed.requestIntervalMs, 3000);
});

test("webSelectorConfigSchema 拒绝低于下限的请求间隔（防打爆对方站点）", () => {
  const result = webSelectorConfigSchema.safeParse({
    searchUrl: "https://x.com/s?q={keyword}",
    searchItemSelector: ".i",
    searchNameSelector: ".n",
    requestIntervalMs: 10,
  });
  assert.equal(result.success, false);
});

test("webSelectorConfigSchema 拒绝空选择器", () => {
  const result = webSelectorConfigSchema.safeParse({
    searchUrl: "https://x.com/s?q={keyword}",
    searchItemSelector: "",
    searchNameSelector: ".n",
  });
  assert.equal(result.success, false);
});

/* ---------------------------------------------------------------- *
 * 真实量级的大 RSS
 * ---------------------------------------------------------------- */

test("parseFeed 能处理 500 条量级的真实 RSS（dmhy 每页上限）", () => {
  // 实测动漫花园 RSS 搜索每页 500 条、约 2 MB；
  // 这里构造同量级 fixture，确认解析不会退化或错位
  const itemsXml = Array.from({ length: 500 }, (_, i) => `
    <item>
      <title>[字幕组] 测试番剧 第${String(i + 1).padStart(2, "0")}话 [1080p]</title>
      <link>https://anime.example.com/topic/${i}</link>
      <enclosure url="https://anime.example.com/t/${i}.torrent" length="${700 * 1024 * 1024}" type="application/x-bittorrent"/>
      <pubDate>Mon, 0${(i % 9) + 1} Oct 2024 12:00:00 +0800</pubDate>
    </item>`).join("");

  const xml = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>T</title>${itemsXml}</channel></rss>`;

  const items = parseFeed(xml, BASE);
  assert.equal(items.length, 500, "应完整解析 500 条");
  assert.match(items[0].title, /第01话/);
  assert.match(items[499].title, /第500话/);
  assert.equal(items[499].url, "https://anime.example.com/t/499.torrent");
});

test("filterFeedItems 在大列表上按 torrentOnly 正确过滤", () => {
  const items = parseFeed(
    `<rss><channel>
      <item><title>A</title><enclosure url="https://x.com/a.torrent"/></item>
      <item><title>B</title><link>https://x.com/page-b</link></item>
      <item><title>C</title><enclosure url="magnet:?xt=urn:btih:abc"/></item>
    </channel></rss>`,
    BASE,
  );
  assert.equal(items.length, 3);
  const filtered = filterFeedItems(items, { torrentOnly: true } as never);
  assert.equal(filtered.length, 2, "只保留种子/磁力");
  assert.deepEqual(filtered.map((i) => i.title), ["A", "C"]);
});
