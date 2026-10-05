/**
 * 好友（单向关注）的隐私规则测试。
 *
 * ## 防的是什么
 *
 * 关注只解除「你完全不认识这个人」的壁垒，**不是内容授权**。
 * `Collection.isPrivate` 为真的收藏是用户在 Bangumi 上明确设为私密的内容 ——
 * 给关注者看就是泄露。
 *
 * 这条规则写错的形态非常隐蔽：界面完全正常、没有任何报错，只是别人的
 * 私密条目安静地出现在列表里。只有测试能拦住。
 *
 * 同一条规则在项目里出现三处（时光机、收藏短评、追番列表），
 * 各自的表达方式不同（前两处逐行过滤，这里决定查询条件）——
 * 因此每处都要有自己的断言。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldHidePrivate } from "@/lib/friends/repository";
import { isCommentVisible } from "@/lib/review/collection-comments";

const ME = "user-me";
const OTHER = "user-other";

test("看自己的追番时不过滤私密", () => {
  assert.equal(shouldHidePrivate(ME, ME), false);
});

test("看别人的追番时过滤私密", () => {
  assert.equal(shouldHidePrivate(ME, OTHER), true);
});

test("未登录访客也过滤私密（不能因为 viewer 为空就放行）", () => {
  assert.equal(shouldHidePrivate(null, OTHER), true, "未登录访客不该看到任何私密收藏");
  // 甚至「未登录看未登录」也不该成立 —— null !== otherId 恒真
  assert.equal(shouldHidePrivate(null, ME), true);
});

test("判定是纯比较，不依赖顺序之外的任何状态", () => {
  // 穷举，确认没有「某个组合意外放行」的分支
  const cases: [string | null, string, boolean][] = [
    [ME, ME, false],
    [ME, OTHER, true],
    [OTHER, ME, true],
    [null, ME, true],
    [null, OTHER, true],
  ];
  for (const [viewer, owner, expected] of cases) {
    assert.equal(
      shouldHidePrivate(viewer, owner),
      expected,
      `viewer=${viewer} owner=${owner}`,
    );
  }
});

test("与收藏短评的可见性规则方向一致（同一个隐私原则）", () => {
  // 两处规则各有实现，但**语义必须一致**：私密内容只有本人可见。
  // 这条断言把两个实现绑在一起 —— 谁改错都会在这里响。
  for (const viewer of [ME, OTHER, null]) {
    // 追番列表：不是本人就要过滤
    const listHides = shouldHidePrivate(viewer, ME);
    // 收藏短评：私密内容对非本人不可见
    const commentHidden = !isCommentVisible({ isPrivate: true, userId: ME }, viewer);
    assert.equal(
      listHides,
      commentHidden,
      `viewer=${viewer} 时两处隐私规则不一致（列表 hides=${listHides}，短评 hidden=${commentHidden}）`,
    );
  }
});
