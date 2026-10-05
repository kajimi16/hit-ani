/**
 * 绑定冲突 → 用户可见响应的映射测试。
 *
 * ## 防的是什么
 *
 * 真实事故：`bgmUserId` 的唯一约束冲突没被识别，接口把这条原文返回给了用户：
 *
 *     Invalid `prisma.bgmBinding.upsert()` invocation:
 *     Unique constraint failed on the fields: (`bgmUserId`)
 *
 * 用户既看不懂发生了什么，也不知道能做什么。这组断言锁死两件事：
 * 状态码必须是 409（冲突，而不是「你的请求有问题」），以及**任何情况下
 * 都不能把 Prisma 的内部字样漏出去**。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BgmAccountTakenError } from "@/lib/auth/bgm-oauth";
import { bindingErrorResponse } from "@/lib/auth/binding-response";

/** 用户可见的全部文本。 */
function visibleText(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

test("账号被占用 → 409，且带机器可读的 code 供界面弹确认", () => {
  const { status, body } = bindingErrorResponse(new BgmAccountTakenError(969359, "kajimi"));

  assert.equal(status, 409, "这是资源状态冲突，不是请求参数错误");
  assert.equal(body.code, "BGM_ACCOUNT_TAKEN");
  assert.equal(body.bgmUserId, 969359);
  assert.equal(body.bgmUsername, "kajimi");
  assert.ok(typeof body.error === "string" && body.error.length > 0);
});

test("绝不把 Prisma 内部字样漏给用户", () => {
  // 这条是这次事故的直接回归防线。
  const { body } = bindingErrorResponse(new BgmAccountTakenError(969359, "kajimi"));
  const text = visibleText(body);

  for (const leak of [
    "prisma",
    "Prisma",
    "Unique constraint",
    "invocation",
    "P2002",
    "bgmUserId",
    "upsert",
  ]) {
    // `bgmUserId` 作为**字段名**出现时是数据（值 969359），不是实现细节；
    // 只要不以它作为键名泄漏即可。
    if (leak === "bgmUserId") {
      assert.equal(Object.keys(body).includes("bgmUserId"), true);
      assert.equal(text.includes("Unique constraint"), false);
      continue;
    }
    assert.equal(text.includes(leak), false, `响应里泄漏了 ${leak}`);
  }
});

test("提示要说清发生了什么，而不是只说「失败」", () => {
  const { body } = bindingErrorResponse(new BgmAccountTakenError(969359, "kajimi"));
  assert.match(String(body.error), /已经绑定/);
  assert.match(String(body.error), /kajimi/);
});

test("缺少用户名时提示仍完整且没有空括号", () => {
  const { body } = bindingErrorResponse(new BgmAccountTakenError(1, null));
  assert.match(String(body.error), /已经绑定/);
  assert.equal(String(body.error).includes("（）"), false);
  assert.equal(body.bgmUsername, null);
});

test("其它错误仍是 400 并保留原始信息（上游校验失败该让用户看到）", () => {
  const { status, body } = bindingErrorResponse(new Error("Bangumi 令牌无效或已过期"));
  assert.equal(status, 400);
  assert.equal(body.error, "Bangumi 令牌无效或已过期");
  assert.equal(body.code, undefined, "非冲突不应带 code");
});

test("非 Error 值也能安全映射，不会抛出", () => {
  for (const thrown of ["字符串", 42, null, undefined, { weird: true }]) {
    const { status, body } = bindingErrorResponse(thrown);
    assert.equal(status, 400);
    assert.ok(typeof body.error === "string");
  }
});

test("只有 BgmAccountTakenError 会得到 409", () => {
  // 防止有人顺手把「任何 Prisma 错误」都当成冲突 —— 那会让界面在真正的
  // 故障时弹出「是否迁移」的确认，误导用户。
  const others = [
    new Error("boom"),
    Object.assign(new Error("db down"), { code: "P2002" }),
    new TypeError("fetch failed"),
  ];
  for (const error of others) {
    assert.equal(bindingErrorResponse(error).status, 400, `${error.name} 不该被当成冲突`);
  }
});
