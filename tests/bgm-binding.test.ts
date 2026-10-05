/**
 * Bangumi 绑定冲突的判定测试。
 *
 * ## 真实事故
 *
 * `BgmBinding.userId` 是主键、`bgmUserId` 是唯一键。绑定走的是
 * `upsert({ where: { userId } })` —— **只按主键判断**。于是当「本地账号 B
 * 想绑定一个已被本地账号 A 绑定的 BGM 账号」时，它会走 `create` 分支，
 * 一头撞在 `bgmUserId` 的唯一约束上，把这条报错原文甩到用户面前：
 *
 *     Invalid `prisma.bgmBinding.upsert()` invocation:
 *     Unique constraint failed on the fields: (`bgmUserId`)
 *
 * 用户看到的是一句 Prisma 内部报错，既没说明发生了什么，也没说能做什么。
 *
 * ## 为什么用纯函数来锁
 *
 * 这个分支的判定不依赖数据库，只有三种结果。抽成 `planBinding` 之后可以直接
 * 穷举覆盖，而不必为了测一条分支去动真实库。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BgmAccountTakenError, planBinding } from "@/lib/auth/bgm-oauth";

const ME = "user-me";
const OTHER = "user-other";
const holderIsMe = { userId: ME };
const holderIsOther = { userId: OTHER };

test("无人持有时正常写入", () => {
  assert.equal(planBinding(null, ME, false), "write");
  assert.equal(planBinding(null, ME, true), "write", "无人持有就是普通写入，与 takeOver 无关");
});

test("自己重复绑定走 update，不算冲突", () => {
  // 这条是「换令牌重绑」的路径：同一个本地账号换一个 BGM 令牌，
  // 必须顺利更新而不是报「已被占用」。
  assert.equal(planBinding(holderIsMe, ME, false), "write");
  assert.equal(planBinding(holderIsMe, ME, true), "write");
});

test("他人持有且未确认 → conflict（不再漏出 Prisma 原文）", () => {
  assert.equal(planBinding(holderIsOther, ME, false), "conflict");
});

test("他人持有且已确认 → take-over", () => {
  assert.equal(planBinding(holderIsOther, ME, true), "take-over");
});

test("穷举三种持有状态 × 两种授权，全部有明确结论", () => {
  const plans = new Set<string>();
  for (const holder of [null, holderIsMe, holderIsOther]) {
    for (const takeOver of [false, true]) {
      const plan = planBinding(holder, ME, takeOver);
      assert.ok(
        ["write", "conflict", "take-over"].includes(plan),
        `holder=${JSON.stringify(holder)} takeOver=${takeOver} 得到意外的 ${plan}`,
      );
      plans.add(plan);
    }
  }
  // 三种结果都必须可达，否则说明某个分支是死代码
  assert.deepEqual([...plans].sort(), ["conflict", "take-over", "write"]);
});

test("未确认时永不返回 take-over —— 不允许静默迁移", () => {
  // 这条是安全底线：迁移会让原来那个本地账号失去绑定，
  // 只有用户明确同意（takeOver=true）才允许。
  for (const holder of [null, holderIsMe, holderIsOther]) {
    assert.notEqual(planBinding(holder, ME, false), "take-over");
  }
});

test("冲突错误带上了可展示的信息，供界面说明「被谁占用了」", () => {
  const error = new BgmAccountTakenError(969359, "kajimi");
  assert.equal(error.name, "BgmAccountTakenError");
  assert.equal(error.bgmUserId, 969359);
  assert.equal(error.bgmUsername, "kajimi");
  assert.match(error.message, /kajimi/, "提示里应带上占用的 BGM 用户名");
  assert.match(error.message, /已经绑定/, "提示要说清发生了什么");
  // 绝不出现 Prisma 的内部字样
  assert.equal(/prisma|Unique constraint|invocation/i.test(error.message), false);
});

test("缺少用户名时提示仍然可读", () => {
  const error = new BgmAccountTakenError(969359, null);
  assert.match(error.message, /已经绑定/);
  assert.equal(error.message.includes("（）"), false, "不要留下空括号");
});
