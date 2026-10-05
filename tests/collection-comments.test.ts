/**
 * 收藏短评的可见性规则测试。
 *
 * ## 防的是什么
 *
 * `Collection.isPrivate` 是用户在 Bangumi 上**明确设为私密**的收藏。把它的
 * 短评展示给别人就是泄露 —— 而这类错误**没有报错、界面看起来也正常**，
 * 只有测试能拦住。
 *
 * 同一条规则也写在 `src/lib/timeline/repository.ts`（时光机那边用查询条件
 * 表达）。两处必须一致，改动时都要动 —— 这是本文件存在的第二个理由。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isCommentVisible } from "@/lib/review/collection-comments";

const ME = "user-me";
const OTHER = "user-other";

test("公开短评对所有人可见", () => {
  const comment = { isPrivate: false, userId: OTHER };
  assert.equal(isCommentVisible(comment, null), true, "未登录访客也应能看到公开短评");
  assert.equal(isCommentVisible(comment, ME), true);
});

test("私密短评对他人不可见", () => {
  const comment = { isPrivate: true, userId: OTHER };
  assert.equal(isCommentVisible(comment, ME), false, "别人的私密短评不该展示");
  assert.equal(isCommentVisible(comment, null), false, "未登录访客更不该看到");
});

test("私密短评对**本人**可见", () => {
  // 用户自己当然要看得到自己设为私密的那条 —— 否则他以为内容丢了。
  assert.equal(isCommentVisible({ isPrivate: true, userId: ME }, ME), true);
});

test("穷举四种组合，结论互不矛盾", () => {
  const cases = [
    [{ isPrivate: false, userId: ME }, ME, true],
    [{ isPrivate: false, userId: OTHER }, ME, true],
    [{ isPrivate: true, userId: ME }, ME, true],
    [{ isPrivate: true, userId: OTHER }, ME, false],
    [{ isPrivate: true, userId: OTHER }, null, false],
    [{ isPrivate: false, userId: OTHER }, null, true],
  ] as const;

  for (const [comment, viewer, expected] of cases) {
    assert.equal(
      isCommentVisible(comment, viewer),
      expected,
      `isPrivate=${comment.isPrivate} owner=${comment.userId} viewer=${viewer}`,
    );
  }
});

test("未登录时没有任何私密内容可见", () => {
  // 未登录访客不该因为「没有 viewer」而意外放行。
  for (const userId of [ME, OTHER]) {
    assert.equal(isCommentVisible({ isPrivate: true, userId }, null), false);
  }
});
