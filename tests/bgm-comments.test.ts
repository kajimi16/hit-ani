/**
 * Bangumi 评论解析测试。
 *
 * ## 防的是什么
 *
 * BGM **没有评论 API**（46 个 `/v0/*` 路径逐个核对过），只能抓
 * `bgm.tv/subject/{id}/comments` 的 HTML 再解析。HTML 解析的错误是**静默**的：
 * 选择器写错时不会抛异常，只是少几条评论或字段为空 —— 用户看到的是
 * 「这部番没人评论」，而其实是我们的正则没匹配上。
 *
 * 因此这里用**真实抓下来的 HTML**（`fixtures-bgm-comments.html`，20 条评论、
 * 141 页）做断言，而不是自己拼一段理想化的 HTML —— 后者会掩盖真实结构里的
 * 各种变体（实测有 `{id}.jpg` 与 `{id}_自定义后缀.jpg` 两种头像文件名）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseComments } from "@/lib/bgm/comments";

const html = readFileSync(new URL("./fixtures-bgm-comments.html", import.meta.url), "utf8");
const page = parseComments(html);

test("能从真实页面里解析出全部评论", () => {
  assert.equal(page.comments.length, 20, "评论条数与页面上的 .item.clearit 数量不符");
});

test("总页数从分页链接读出（不是硬编码 1）", () => {
  assert.equal(page.totalPages, 141);
});

test("每条评论都有正文与用户名", () => {
  for (const comment of page.comments) {
    assert.ok(comment.text.length > 0, `有评论没有正文：${JSON.stringify(comment)}`);
    assert.ok(comment.user.length > 0, "有评论没有用户名");
  }
});

test("每条的 userId 都能取到 —— 两种头像文件名都要认", () => {
  // 用户名有两种：数字 ID（`/user/724489`）与自定义名（`/user/sumeng1234`）。
  // 后者只能从头像路径拿 ID，而头像文件名又有 `{id}.jpg` 与 `{id}_{后缀}.jpg`
  // 两种 —— 只认一种会让一部分评论的 userId 为 null。
  const missing = page.comments.filter((c) => !c.userId);
  assert.deepEqual(missing, [], `有 ${missing.length} 条拿不到 userId`);
});

test("评分只在 1–10 范围内，取不到时为 null", () => {
  for (const comment of page.comments) {
    if (comment.rating === null) continue;
    assert.ok(
      comment.rating >= 1 && comment.rating <= 10,
      `越界评分 ${comment.rating}（${comment.user}）`,
    );
  }
  // 真实数据里应有评分（否则说明 stars 正则失效了）
  assert.ok(
    page.comments.filter((c) => c.rating !== null).length > 0,
    "一条评分都没解析出来，stars 正则可能失效",
  );
});

test("头像地址被补全为绝对 URL", () => {
  // 页面里写的是协议相对的 `//lain.bgm.tv/...`；直接拿去渲染会被当成
  // 相对路径，图片全裂。
  for (const comment of page.comments) {
    if (!comment.avatarUrl) continue;
    assert.ok(
      comment.avatarUrl.startsWith("https://"),
      `头像不是绝对 URL：${comment.avatarUrl}`,
    );
  }
});

test("收藏状态与时间被分开取（不能混成一个字段）", () => {
  const withBoth = page.comments.filter((c) => c.collectionType && c.timeText);
  assert.ok(withBoth.length > 0, "没有同时解析出状态与时间的评论");
  for (const comment of withBoth) {
    assert.ok(
      !comment.collectionType!.startsWith("@"),
      `状态字段混进了时间：${comment.collectionType}`,
    );
    assert.ok(
      comment.timeText!.startsWith("@"),
      `时间字段格式不符：${comment.timeText}`,
    );
  }
});

test("畸形 HTML 返回空结果而不是抛错", () => {
  // 上游页面结构变化时，宁可显示「没有评论」也不能让详情页 500。
  for (const bad of ["", "<html></html>", "<div>无关内容</div>", "not html at all"]) {
    const result = parseComments(bad);
    assert.deepEqual(result.comments, []);
    assert.equal(result.totalPages, 1, "没有分页信息时应为 1");
  }
});

test("没有正文的条目被跳过（占位块不该当评论）", () => {
  const withEmpty = parseComments(`
    <div class="item clearit" data-item-user="1">
      <a href="/user/1" class="l">某人</a>
      <p class="comment"></p>
    </div>
  `);
  assert.deepEqual(withEmpty.comments, []);
});
