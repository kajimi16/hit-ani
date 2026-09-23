/**
 * Animeko 源导入 与 视频地址提取 的单测。
 *
 * 这两块都是「实测踩出来的坑」，值得用测试钉死：
 *  1. 视频地址在 CMS 页面里是 **JSON 转义**的（`https:\/\/`），
 *     直接匹配 `https://` 永远找不到 —— 而作者在浏览器里看不到这个差异。
 *  2. Animeko 的 `matchVideoUrl` 是用于测试**单个候选 URL** 的，普遍带 `^` 锚点。
 *     拿它匹配整篇 HTML 会全部失配。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractVideoUrl,
  findUrlCandidates,
  normalizeForVideoMatch,
} from "@/lib/media/extract";
import { convertAnimekoExport, convertAnimekoSource } from "@/lib/media/animeko-import";
import { SearchMode } from "@/lib/media/source-config";

/* ---------------------------------------------------------------- *
 * 转义归一化
 * ---------------------------------------------------------------- */

test("normalizeForVideoMatch 还原 JSON 斜杠转义（最常见的坑）", () => {
  // MacCMS 系把播放地址塞在 player_aaaa={"url":"https:\\/\\/..."} 里
  assert.equal(
    normalizeForVideoMatch('"url":"https:\\/\\/play.example.com\\/a\\/index.m3u8"'),
    '"url":"https://play.example.com/a/index.m3u8"',
  );
});

test("normalizeForVideoMatch 还原 Unicode 转义", () => {
  assert.equal(normalizeForVideoMatch("\\u9b54\\u6cd5"), "魔法");
});

test("normalizeForVideoMatch 同时处理 HTML 实体与 JSON 转义", () => {
  assert.equal(
    normalizeForVideoMatch('https:\\/\\/x.com\\/a.m3u8?t=1&amp;b=2'),
    "https://x.com/a.m3u8?t=1&b=2",
  );
});

/* ---------------------------------------------------------------- *
 * URL 候选与正则语义
 * ---------------------------------------------------------------- */

test("findUrlCandidates 抽出 URL 并止于引号/空白/尖括号", () => {
  const html = '<a href="https://a.com/x.m3u8">及 https://b.com/y.mp4 与 https://c.com/z';
  assert.deepEqual(findUrlCandidates(html), [
    "https://a.com/x.m3u8",
    "https://b.com/y.mp4",
    "https://c.com/z",
  ]);
});

test("extractVideoUrl 能处理带 ^ 锚点的正则（Animeko 语义）", () => {
  // Animeko 的正则是测试单个 URL 的，因此带 ^；直接匹配整篇 HTML 会失配
  const pattern = "(^http(s)?:\\/\\/(?!.*http(s)?:\\/\\/).+((\\.mp4)|(\\.mkv)|(m3u8)).*(\\?.+)?)|(akamaized)|(bilivideo.com)";
  const html = 'player_aaaa={"url":"https:\\/\\/play.example.com:65\\/v\\/index.m3u8","from":"x"}';
  assert.equal(extractVideoUrl(html, pattern), "https://play.example.com:65/v/index.m3u8");
});

test("extractVideoUrl 对 mp4 与 m3u8 都能提取", () => {
  const pattern = "(^http(s)?:\\/\\/.*\\.(mp4|m3u8))";
  assert.equal(
    extractVideoUrl('src="https://cdn.example.com/a.mp4"', pattern),
    "https://cdn.example.com/a.mp4",
  );
  assert.equal(
    extractVideoUrl('src="https://cdn.example.com/a.m3u8"', pattern),
    "https://cdn.example.com/a.m3u8",
  );
});

test("extractVideoUrl 优先取命名分组 (?<v>...)", () => {
  const pattern = '(.+top/\\?url=(?<v>https://play\\.example\\.com/.+))';
  const html = 'x="https://jump.example.com/top/?url=https://play.example.com/a/index.m3u8"';
  assert.equal(
    extractVideoUrl(html, pattern),
    "https://play.example.com/a/index.m3u8",
  );
});

test("extractVideoUrl 无 m3u8 时返回 null（不返回无关 URL）", () => {
  const pattern = "(^http(s)?:\\/\\/.*\\.(mp4|m3u8))";
  assert.equal(extractVideoUrl('<a href="https://a.com/page.html">x</a>', pattern), null);
});

test("extractVideoUrl 对非法正则返回 null 而非抛错", () => {
  assert.equal(extractVideoUrl("<html></html>", "([unclosed"), null);
});

/* ---------------------------------------------------------------- *
 * Animeko 格式转换
 * ---------------------------------------------------------------- */

test("convertAnimekoSource 转换 subjectFormatId=a 的源", () => {
  const converted = convertAnimekoSource({
    name: "测试A型",
    searchUrl: "https://a.com/search?wd={keyword}",
    subjectFormatId: "a",
    selectorSubjectFormatA: { selectLists: ".list h4 > a" },
    channelFormatId: "index-grouped",
    selectorChannelFormatFlattened: {
      selectEpisodeLists: ".playlist",
      selectEpisodesFromList: "a",
    },
    matchVideo: { matchVideoUrl: "(?<v>https://cdn/.+\\.m3u8)" },
  });

  assert.equal(converted.config.searchMode, SearchMode.Nested);
  assert.equal(converted.config.searchItemSelector, ".list h4 > a");
  // 条目元素自身即链接 —— 不设 name/link 选择器，由解析器取其自身文本与 href
  assert.equal(converted.config.searchNameSelector, undefined);
  assert.equal(converted.config.searchLinkSelector, undefined);
  // 容器 + 条目合并为后代选择器
  assert.equal(converted.config.episodeItemSelector, ".playlist a");
  assert.equal(converted.config.videoUrlPattern, "(?<v>https://cdn/.+\\.m3u8)");
});

test("convertAnimekoSource 转换 subjectFormatId=indexed 的源为 parallel 模式", () => {
  const converted = convertAnimekoSource({
    name: "测试Indexed",
    searchUrl: "https://b.com/s?q={keyword}",
    subjectFormatId: "indexed",
    selectorSubjectFormatIndexed: {
      selectNames: ".thumb-txt",
      selectLinks: ".thumb-menu > a",
    },
    channelFormatId: "no-channel",
    selectorChannelFormatNoChannel: { selectEpisodes: "#glist a" },
  });

  assert.equal(converted.config.searchMode, SearchMode.Parallel);
  assert.equal(converted.config.searchNameSelector, ".thumb-txt");
  assert.equal(converted.config.searchLinkSelector, ".thumb-menu > a");
  assert.equal(converted.config.episodeItemSelector, "#glist a");
});

test("convertAnimekoSource 丢弃 $^ 禁用标记（Animeko 用永不匹配的正则表示禁用）", () => {
  const converted = convertAnimekoSource({
    name: "禁用嵌套",
    searchUrl: "https://c.com/s?q={keyword}",
    subjectFormatId: "a",
    selectorSubjectFormatA: { selectLists: ".x a" },
    matchVideo: { enableNestedUrl: true, matchNestedUrl: "$^" },
  });
  assert.equal(converted.config.nestedUrlPattern, undefined);
});

test("convertAnimekoSource 映射关键词处理模式", () => {
  const base = {
    searchUrl: "https://d.com/s?q={keyword}",
    subjectFormatId: "a" as const,
    selectorSubjectFormatA: { selectLists: ".x a" },
  };
  assert.equal(convertAnimekoSource({ ...base, name: "1", searchUseOnlyFirstWord: true }).config.keywordMode, "first-word");
  assert.equal(convertAnimekoSource({ ...base, name: "2", searchRemoveSpecial: true }).config.keywordMode, "strip-special");
  assert.equal(convertAnimekoSource({ ...base, name: "3" }).config.keywordMode, "raw");
  // 两个都开时取更激进的 first-word
  assert.equal(
    convertAnimekoSource({ ...base, name: "4", searchUseOnlyFirstWord: true, searchRemoveSpecial: true }).config.keywordMode,
    "first-word",
  );
});

test("convertAnimekoSource 把 cookies 与 UA 提为请求头", () => {
  const converted = convertAnimekoSource({
    name: "带头",
    searchUrl: "https://e.com/s?q={keyword}",
    subjectFormatId: "a",
    selectorSubjectFormatA: { selectLists: ".x a" },
    matchVideo: { cookies: "quality=1080", addHeadersToVideo: { userAgent: "TestUA/1.0" } },
  });
  assert.equal(converted.config.headers?.Cookie, "quality=1080");
  assert.equal(converted.config.headers?.["User-Agent"], "TestUA/1.0");
  // 未显式给 referer 时用站点自身 origin（最接近浏览器内导航）
  assert.equal(converted.config.headers?.Referer, "https://e.com");
});

test("convertAnimekoSource 缺少必需字段时抛错并指出原因", () => {
  assert.throws(
    () => convertAnimekoSource({ name: "缺链接", searchUrl: "" }),
    /缺少 searchUrl/,
  );
  assert.throws(
    () =>
      convertAnimekoSource({
        name: "indexed 缺字段",
        searchUrl: "https://f.com/?q={keyword}",
        subjectFormatId: "indexed",
        selectorSubjectFormatIndexed: { selectNames: ".n" },
      }),
    /缺少 selectNames\/selectLinks/,
  );
});

test("convertAnimekoSource 记录能力差异（tier 被丢弃）", () => {
  const converted = convertAnimekoSource({
    name: "带权重",
    searchUrl: "https://g.com/s?q={keyword}",
    subjectFormatId: "a",
    selectorSubjectFormatA: { selectLists: ".x a" },
    tier: 3,
  });
  assert.ok(converted.notes.some((n) => n.includes("tier")), "应告知用户权重被丢弃");
});

test("convertAnimekoExport 逐个报告失败，不因一个源坏掉而全盘失败", () => {
  const { converted, failed } = convertAnimekoExport({
    sources: [
      {
        name: "好的",
        searchUrl: "https://ok.com/s?q={keyword}",
        subjectFormatId: "a",
        selectorSubjectFormatA: { selectLists: ".x a" },
      },
      { name: "坏的", searchUrl: "" },
    ],
  });
  assert.equal(converted.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].name, "坏的");
});
