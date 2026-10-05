/**
 * NSFW 偏好测试。
 *
 * ## 防的是什么
 *
 * 这个偏好决定**服务端请求哪些条目**，映射写错的后果是「内容过滤失效」——
 * 一种不会被任何功能测试发现、但后果严重的问题。两个具体风险：
 *
 * 1. **默认值必须是「不显示」**。校内平台默认展示对所有人都合适的内容；
 *    反过来（默认显示、需自己关）会让不知情的用户直接撞见 R18 条目。
 * 2. **「显示」不能翻译成 `nsfw: true`**。BGM 的 `true` 需要账号权限，
 *    无权限时会被**静默忽略**；而 `undefined`（不传该键）才是「拿全部可用结果」。
 *    写成 `true` 会让没有权限的用户看到「打开了但什么都没变」，且无从判断原因。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_NSFW_PREFERENCE,
  NSFW_COOKIE,
  NSFW_LABELS,
  isNsfwPreference,
  nsfwFilterValue,
  parseNsfwCookie,
} from "@/lib/nsfw";

test("默认是「不显示」", () => {
  // 校内平台的默认值必须对所有人都合适。
  assert.equal(DEFAULT_NSFW_PREFERENCE, "hide");
  assert.equal(nsfwFilterValue(DEFAULT_NSFW_PREFERENCE), false);
});

test("cookie 缺失或非法时退回默认（不显示）", () => {
  for (const raw of [undefined, "", "0", "yes", "HIDE", "true", "false"]) {
    assert.equal(parseNsfwCookie(raw), "hide", `${JSON.stringify(raw)} 未退回默认`);
  }
  assert.equal(parseNsfwCookie("hide"), "hide");
  assert.equal(parseNsfwCookie("show"), "show");
});

test("「不显示」翻译成 nsfw:false", () => {
  assert.equal(nsfwFilterValue("hide"), false);
});

test("「显示」翻译成 undefined（整个键不传），不是 true", () => {
  // `true` 需要 BGM 权限、无权限会被静默忽略。不传才是正确的写法。
  const value = nsfwFilterValue("show");
  assert.equal(value, undefined);
  assert.notEqual(value, true);
});

test("过滤值只有两种可能，不存在「既不是 false 也不是 undefined」的情况", () => {
  // 调用方靠 `nsfw === undefined ? {} : { nsfw }` 展开，多一种取值就会出错。
  for (const preference of ["hide", "show"] as const) {
    const value = nsfwFilterValue(preference);
    assert.ok(value === false || value === undefined, `${preference} 得到 ${String(value)}`);
  }
});

test("cookie 名与标签都非空，避免写入无名 cookie", () => {
  assert.ok(NSFW_COOKIE.length > 0);
  assert.equal(NSFW_LABELS.hide, "不显示");
  assert.equal(NSFW_LABELS.show, "显示");
});

test("类型守卫只认这两个字面量", () => {
  assert.equal(isNsfwPreference("hide"), true);
  assert.equal(isNsfwPreference("show"), true);
  for (const bad of ["", "SHOW", true, null, undefined, 1, {}]) {
    assert.equal(isNsfwPreference(bad), false);
  }
});
