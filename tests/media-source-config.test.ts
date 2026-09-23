/**
 * 源配置单测：关键词处理、URL 模板、基址推导。
 *
 * 这些函数看着简单，但都是「配错了不会报错、只会搜不到」的静默失败点 ——
 * 例如模板里忘了写 `{keyword}`，界面一切正常，搜索永远返回同一页。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  KeywordMode,
  MIN_REQUEST_INTERVAL_MS,
  SOURCE_PRESETS,
  SourceFactory,
  deriveBaseUrl,
  expandTemplate,
  hasKeywordPlaceholder,
  hasPagePlaceholder,
  rssConfigSchema,
  sourceConfigSchema,
  stripSpecialChars,
  transformKeyword,
  webSelectorConfigSchema,
} from "@/lib/media/source-config";

/* ---------------------------------------------------------------- *
 * 关键词处理
 * ---------------------------------------------------------------- */

test("stripSpecialChars 去掉常见特殊字符但保留中日文与空格", () => {
  assert.equal(stripSpecialChars("反叛的鲁路修！"), "反叛的鲁路修");
  assert.equal(stripSpecialChars("魔法少女☆小圆"), "魔法少女 小圆");
  assert.equal(stripSpecialChars("Code Geass"), "Code Geass");
  assert.equal(stripSpecialChars("进击的巨人（第1季）"), "进击的巨人 第1季");
});

test("transformKeyword: raw 原样返回", () => {
  assert.equal(transformKeyword("  魔法少女 小圆  ", KeywordMode.Raw), "魔法少女 小圆");
});

test("transformKeyword: first-word 只取第一个词", () => {
  assert.equal(transformKeyword("魔法少女 小圆", KeywordMode.FirstWord), "魔法少女");
  assert.equal(transformKeyword("Code Geass R2", KeywordMode.FirstWord), "Code");
  // 只有一个词时返回它本身，而不是空串
  assert.equal(transformKeyword("鲁路修", KeywordMode.FirstWord), "鲁路修");
});

test("transformKeyword: strip-special 去特殊字符", () => {
  assert.equal(transformKeyword("反叛的鲁路修！", KeywordMode.StripSpecial), "反叛的鲁路修");
});

test("transformKeyword 在全被剥掉时回退到原串（避免搜空）", () => {
  // 全是特殊字符 → strip 后为空 → 回退原文，而不是发起空查询
  assert.equal(transformKeyword("!!!", KeywordMode.StripSpecial), "!!!");
});

/* ---------------------------------------------------------------- *
 * URL 模板
 * ---------------------------------------------------------------- */

test("expandTemplate 替换 {keyword} 并做 URL 编码", () => {
  const url = expandTemplate("https://x.com/s?q={keyword}", { keyword: "魔法少女" });
  assert.equal(url, `https://x.com/s?q=${encodeURIComponent("魔法少女")}`);
});

test("expandTemplate 同时支持 {word} 别名", () => {
  assert.equal(
    expandTemplate("https://x.com/s?w={word}", { keyword: "abc" }),
    "https://x.com/s?w=abc",
  );
});

test("expandTemplate 展开 {page} 为数字（不编码）", () => {
  assert.equal(
    expandTemplate("https://x.com/s?q={keyword}&p={page}", { keyword: "a", page: 2 }),
    "https://x.com/s?q=a&p=2",
  );
});

test("expandTemplate 未传 page 时保留占位符（不静默变成空）", () => {
  const url = expandTemplate("https://x.com/{page}", { keyword: "a" });
  assert.equal(url, "https://x.com/{page}");
});

test("expandTemplate 编码空格与中文，不产生非法 URL", () => {
  const url = expandTemplate("https://x.com/s?q={keyword}", { keyword: "魔法 少女" });
  assert.doesNotThrow(() => new URL(url));
  assert.ok(!url.includes(" "), "URL 中不应含裸露空格");
});

test("hasKeywordPlaceholder 检测常见写法", () => {
  assert.equal(hasKeywordPlaceholder("https://x.com?q={keyword}"), true);
  assert.equal(hasKeywordPlaceholder("https://x.com?q={word}"), true);
  assert.equal(hasKeywordPlaceholder("https://x.com/fixed"), false);
});

test("hasPagePlaceholder 检测翻页占位符", () => {
  assert.equal(hasPagePlaceholder("https://x.com/{page}"), true);
  assert.equal(hasPagePlaceholder("https://x.com/s?q={keyword}"), false);
});

/* ---------------------------------------------------------------- *
 * 基址推导
 * ---------------------------------------------------------------- */

test("deriveBaseUrl 优先使用显式配置", () => {
  assert.equal(
    deriveBaseUrl({ searchUrl: "https://a.com/s?q={keyword}", baseUrl: "https://b.com" }),
    "https://b.com",
  );
});

test("deriveBaseUrl 从含占位符的模板推导（占位符会先被替换）", () => {
  assert.equal(
    deriveBaseUrl({ searchUrl: "https://anime.example.com/search?q={keyword}" }),
    "https://anime.example.com",
  );
  // 路径里的占位符也要能处理
  assert.equal(
    deriveBaseUrl({ searchUrl: "https://x.com/{page}/s?q={keyword}" }),
    "https://x.com",
  );
});

test("deriveBaseUrl 对非法模板返回 null（而不是抛异常）", () => {
  assert.equal(deriveBaseUrl({ searchUrl: "not a url" }), null);
  assert.equal(deriveBaseUrl({ searchUrl: "" }), null);
});

/* ---------------------------------------------------------------- *
 * Schema
 * ---------------------------------------------------------------- */

test("sourceConfigSchema 按 factory 分派到正确的配置 schema", () => {
  const web = sourceConfigSchema.parse({
    factory: SourceFactory.WebSelector,
    config: {
      searchUrl: "https://x.com?q={keyword}",
      searchItemSelector: ".i",
      searchNameSelector: ".n",
    },
  });
  assert.equal(web.factory, SourceFactory.WebSelector);

  const rss = sourceConfigSchema.parse({
    factory: SourceFactory.Rss,
    config: { searchUrl: "https://x.com/rss?q={keyword}" },
  });
  assert.equal(rss.factory, SourceFactory.Rss);
});

test("sourceConfigSchema 拒绝未知 factory", () => {
  const result = sourceConfigSchema.safeParse({
    factory: "unknown-factory",
    config: { searchUrl: "https://x.com" },
  });
  assert.equal(result.success, false);
});

test("rssConfigSchema 默认 interval 与 torrentOnly", () => {
  const parsed = rssConfigSchema.parse({ searchUrl: "https://x.com?q={keyword}" });
  assert.equal(parsed.requestIntervalMs, DEFAULT_REQUEST_INTERVAL_MS);
  assert.equal(parsed.torrentOnly, false);
});

test("配置 schema 强制请求间隔下限（防止把对方站点打爆）", () => {
  const tooFast = rssConfigSchema.safeParse({
    searchUrl: "https://x.com?q={keyword}",
    requestIntervalMs: 1,
  });
  assert.equal(tooFast.success, false);
  assert.ok(MIN_REQUEST_INTERVAL_MS >= 500, "下限不应低于 500ms");
});

test("webSelectorConfigSchema 拒绝超长字段（防注入超长正则/选择器）", () => {
  const result = webSelectorConfigSchema.safeParse({
    searchUrl: "https://x.com?q={keyword}",
    searchItemSelector: ".i",
    searchNameSelector: ".n",
    videoUrlPattern: "a".repeat(2000),
  });
  assert.equal(result.success, false);
});

/* ---------------------------------------------------------------- *
 * 预设
 * ---------------------------------------------------------------- */

test("内置预设全部通过 schema 校验", () => {
  for (const preset of SOURCE_PRESETS) {
    const result = sourceConfigSchema.safeParse({
      factory: preset.factory,
      config: preset.config,
    });
    assert.equal(result.success, true, `预设 ${preset.id} 配置非法：${JSON.stringify(result)}`);
  }
});

test("内置预设的搜索模板都含 {keyword}", () => {
  for (const preset of SOURCE_PRESETS) {
    assert.equal(
      hasKeywordPlaceholder(preset.config.searchUrl),
      true,
      `预设 ${preset.id} 缺少 {keyword} 占位符`,
    );
  }
});

test("内置预设 ID 唯一且都有说明", () => {
  const ids = SOURCE_PRESETS.map((preset) => preset.id);
  assert.equal(new Set(ids).size, ids.length, "预设 ID 重复");
  for (const preset of SOURCE_PRESETS) {
    assert.ok(preset.name.length > 0, `${preset.id} 缺少名称`);
    assert.ok(preset.notes.length > 0, `${preset.id} 缺少注意事项说明`);
  }
});

test("巴哈姆特预设的选择器与 ajax 参数必须保留（否则 JS 渲染页面抓不到东西）", () => {
  const preset = SOURCE_PRESETS.find((p) => p.id === "bahamut-anime");
  assert.ok(preset, "缺少巴哈姆特预设");
  assert.equal(preset.factory, SourceFactory.WebSelector);

  const config = preset.config as { searchUrl: string; searchItemSelector: string };
  // 不带 ajax=1 时搜索结果是前端渲染的，纯 HTML 抓取会得到 0 条
  assert.match(config.searchUrl, /ajax=1/, "必须带 ajax=1");
  assert.ok(config.searchItemSelector.length > 0);
});

test("web-selector 预设必须提供标题与条目选择器", () => {
  for (const preset of SOURCE_PRESETS) {
    if (preset.factory !== SourceFactory.WebSelector) continue;
    const config = preset.config as { searchItemSelector?: string; searchNameSelector?: string };
    assert.ok(config.searchItemSelector, `${preset.id} 缺 searchItemSelector`);
    assert.ok(config.searchNameSelector, `${preset.id} 缺 searchNameSelector`);
  }
});
