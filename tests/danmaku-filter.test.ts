/**
 * 弹幕过滤与举报相关单测。
 *
 * 服务端屏蔽词是**上线前的必需项**：弹幕是校内 UGC，没有这层过滤意味着
 * 违规内容直接进所有人的屏幕，风险落在部署方（学校）。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { blockedWords, hasBlocklist, isBlocked } from "@/lib/danmaku/filter";
import { applyLocalFilters, isValidPattern } from "@/lib/danmaku/local-filter";

/* ---------------------------------------------------------------- *
 * 服务端屏蔽词
 * ---------------------------------------------------------------- */

test("isBlocked 子串匹配且大小写不敏感", () => {
  const words = ["剧透", "spoiler"];
  assert.equal(isBlocked("这里有剧透", words), true);
  assert.equal(isBlocked("这是 SPOILER", words), true);
  assert.equal(isBlocked("完全正常的内容", words), false);
});

test("isBlocked 在词表为空时一律放行（不误伤）", () => {
  // 未配置词表时不能把正常内容也挡掉
  assert.equal(isBlocked("任何内容", []), false);
});

test("isBlocked 能命中中文子串（中文没有词边界，因此不能用 \\b）", () => {
  // 这是选择子串匹配而非整词匹配的原因
  assert.equal(isBlocked("前缀剧透后缀", ["剧透"]), true);
});

test("blockedWords 从环境变量读取并清理空白", () => {
  const original = process.env.DANMAKU_BLOCKED_WORDS;
  try {
    process.env.DANMAKU_BLOCKED_WORDS = " 剧透 , 广告 ,, 刷屏 ";
    assert.deepEqual(blockedWords(), ["剧透", "广告", "刷屏"]);
    assert.equal(hasBlocklist(), true);

    process.env.DANMAKU_BLOCKED_WORDS = "";
    assert.deepEqual(blockedWords(), []);
    assert.equal(hasBlocklist(), false);
  } finally {
    if (original === undefined) delete process.env.DANMAKU_BLOCKED_WORDS;
    else process.env.DANMAKU_BLOCKED_WORDS = original;
  }
});

/* ---------------------------------------------------------------- *
 * 客户端本地过滤
 * ---------------------------------------------------------------- */

const items = [
  { text: "正常弹幕" },
  { text: "这是剧透内容" },
  { text: "前面高能" },
];

test("applyLocalFilters 按正则隐藏", () => {
  const result = applyLocalFilters(items, { patterns: ["剧透"], enabled: true });
  assert.deepEqual(
    result.map((i) => i.text),
    ["正常弹幕", "前面高能"],
  );
});

test("applyLocalFilters 支持多模式（或关系）", () => {
  const result = applyLocalFilters(items, { patterns: ["剧透", "高能"], enabled: true });
  assert.deepEqual(
    result.map((i) => i.text),
    ["正常弹幕"],
  );
});

test("applyLocalFilters 大小写不敏感", () => {
  const result = applyLocalFilters([{ text: "SPOILER!" }], {
    patterns: ["spoiler"],
    enabled: true,
  });
  assert.equal(result.length, 0);
});

test("applyLocalFilters 关闭开关时不过滤", () => {
  const result = applyLocalFilters(items, { patterns: ["剧透"], enabled: false });
  assert.equal(result.length, 3);
});

test("applyLocalFilters 遇到非法正则时跳过而非抛错", () => {
  // 用户在输入框里边打边生效会短暂产生非法正则（如刚输入 `(`），
  // 此时应当只是不过滤，而不是崩掉整个页面
  assert.doesNotThrow(() =>
    applyLocalFilters(items, { patterns: ["("], enabled: true }),
  );
  const result = applyLocalFilters(items, { patterns: ["(", "剧透"], enabled: true });
  assert.deepEqual(
    result.map((i) => i.text),
    ["正常弹幕", "前面高能"],
    "非法正则被忽略，合法的那条仍生效",
  );
});

test("applyLocalFilters 不修改原数组（避免调用方状态被悄悄改掉）", () => {
  const source = [{ text: "a" }];
  const result = applyLocalFilters(source, { patterns: [], enabled: true });
  assert.notEqual(result, source);
  assert.deepEqual(result, source);
});

test("isValidPattern 判定正则合法性", () => {
  assert.equal(isValidPattern("剧透|高能"), true);
  assert.equal(isValidPattern("("), false);
  assert.equal(isValidPattern("[a-z]+"), true);
});
