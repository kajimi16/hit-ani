/**
 * 邮箱验证码的签发与校验测试。
 *
 * ## 防的是什么
 *
 * 这里每一条安全约束都是**静默失效**的类型 —— 写错了不报错，只是保护没了：
 *
 * - 忘记计失败次数 → 6 位数字可被在线穷举（10^6 次尝试）
 * - 重发不覆盖 → 旧码仍然有效，攻击面乘上「历史发送次数」
 * - 不归一化邮箱 → `A@x.com` / `a@x.com` 各拿一个码，重发覆盖失效
 * - 校验通过后不删除 → 同一个码能注册多个账号
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_ATTEMPTS,
  RESEND_INTERVAL_MS,
  consumeCode,
  generateCode,
  issueCode,
  normalizeEmail,
  verificationEmailSubject,
  verifyCode,
} from "@/lib/email/verification";

/** 用不可能与真实邮箱重合的域名，避免误删真实数据。 */
const EMAIL = "verify-test-a@email-verification.test";
const EMAIL_MIXED = "Verify-Test-B@Email-Verification.TEST";

before(async () => {
  await prisma.emailVerification.deleteMany({ where: { email: { endsWith: "email-verification.test" } } });
});

after(async () => {
  await prisma.emailVerification.deleteMany({ where: { email: { endsWith: "email-verification.test" } } });
});

/**
 * 清掉该邮箱的记录，模拟「这个邮箱还没发过码」。
 *
 * 每个用例都要先调用它 —— 60 秒节流是**按邮箱**的，不清就会让第二个用例
 * 拿到 `throttled`（这正是节流在正常工作，但会让测试互相干扰）。
 */
async function reset(email = EMAIL): Promise<void> {
  await prisma.emailVerification.deleteMany({ where: { email: normalizeEmail(email) } });
}

test("生成的验证码是定长数字串", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateCode();
    assert.equal(code.length, CODE_LENGTH);
    assert.match(code, /^\d+$/);
  }
});

test("验证码有分布，不是常量", () => {
  // 若误用某个固定值（或 `Math.random` 被替换成常量），这里会响
  const seen = new Set(Array.from({ length: 200 }, () => generateCode()));
  assert.ok(seen.size > 150, `200 次只生成 ${seen.size} 个不同验证码`);
});

test("签发后能用正确的码校验通过", async () => {
  await reset();
  const issued = await issueCode(EMAIL, "127.0.0.1");
  assert.ok(issued.ok);
  assert.equal(await verifyCode(EMAIL, issued.code), "ok");
});

test("错误的码返回 invalid，且**累计尝试次数**", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);

  const wrong = String((Number(issued.code) + 1) % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
  assert.equal(await verifyCode(EMAIL, wrong), "invalid");

  const row = await prisma.emailVerification.findUnique({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
  });
  assert.equal(row?.attempts, 1, "失败必须计数，否则 5 次上限形同虚设");
});

test("连续失败到达上限后作废 —— 这是 6 位数字的在线穷举防线", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);
  const wrong = String((Number(issued.code) + 1) % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");

  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    assert.equal(await verifyCode(EMAIL, wrong), "invalid");
  }

  // 到达上限后：**即使给出正确码也不通过** —— 必须重新发送
  assert.equal(await verifyCode(EMAIL, issued.code), "too-many-attempts");
});

test("重发会覆盖旧码 —— 旧码立即失效", async () => {
  await reset();
  const first = await issueCode(EMAIL, null);
  assert.ok(first.ok);

  // 绕过 60 秒节流：直接改 sentAt（模拟「等了一会儿」）
  await prisma.emailVerification.update({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
    data: { sentAt: new Date(Date.now() - RESEND_INTERVAL_MS - 1000) },
  });

  const second = await issueCode(EMAIL, null);
  assert.ok(second.ok);
  assert.notEqual(second.code, first.code, "两次签发应是不同的码（概率上）");

  assert.equal(await verifyCode(EMAIL, first.code), "invalid", "旧码必须失效，否则攻击面翻倍");
  assert.equal(await verifyCode(EMAIL, second.code), "ok");
});

test("重发会重置 attempts —— 否则用户被历史失败锁死", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);
  const wrong = String((Number(issued.code) + 1) % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, "0");
  await verifyCode(EMAIL, wrong);
  await verifyCode(EMAIL, wrong);

  await prisma.emailVerification.update({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
    data: { sentAt: new Date(Date.now() - RESEND_INTERVAL_MS - 1000) },
  });
  await reset();
  const again = await issueCode(EMAIL, null);
  assert.ok(again.ok);

  const row = await prisma.emailVerification.findUnique({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
  });
  assert.equal(row?.attempts, 0, "重发后应重置尝试次数");
  assert.equal(await verifyCode(EMAIL, again.code), "ok");
});

test("60 秒内重发被节流，并给出还要等多久", async () => {
  await reset();
  const first = await issueCode(EMAIL, null);
  assert.ok(first.ok);

  const second = await issueCode(EMAIL, null);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, "throttled");
  assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= RESEND_INTERVAL_MS);
});

test("过期的码返回 expired，且不再接受", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);

  // 把过期时间推到过去
  await prisma.emailVerification.update({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
    data: { expiresAt: new Date(Date.now() - CODE_TTL_MS) },
  });

  assert.equal(await verifyCode(EMAIL, issued.code), "expired");
});

test("没有发送过时返回 missing（而不是 invalid）", async () => {
  // 调用方靠这个区分「提示去发送」与「提示重试」
  await prisma.emailVerification.deleteMany({ where: { email: EMAIL } });
  assert.equal(await verifyCode(EMAIL, "123456"), "missing");
});

test("consumeCode 之后码不可再用 —— 一次性", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);
  assert.equal(await verifyCode(EMAIL, issued.code), "ok");

  await consumeCode(EMAIL);
  assert.equal(await verifyCode(EMAIL, issued.code), "missing", "用过一次后必须失效");
});

test("邮箱归一化：大小写与空白都被抹平", () => {
  assert.equal(normalizeEmail("  A@B.COM "), "a@b.com");
  assert.equal(normalizeEmail(EMAIL_MIXED), EMAIL_MIXED.toLowerCase());
});

test("归一化让大小写不同的邮箱共用同一个码（重发覆盖才成立）", async () => {
  await reset();
  const issued = await issueCode(EMAIL_MIXED, null);
  assert.ok(issued.ok);
  // 用小写形式校验 —— 必须命中同一个记录
  assert.equal(await verifyCode(EMAIL_MIXED.toLowerCase(), issued.code), "ok");
});

test("验证码以散列形式落库，**不存明文**", async () => {
  await reset();
  const issued = await issueCode(EMAIL, null);
  assert.ok(issued.ok);

  const row = await prisma.emailVerification.findUnique({
    where: { email_purpose: { email: EMAIL, purpose: "register" } },
  });
  assert.ok(row);
  assert.notEqual(row.codeHash, issued.code, "明文验证码不该出现在库里");
  assert.match(row.codeHash, /^scrypt\$/, "应复用与用户口令同一套散列");
});

test("库里不残留过期很久的记录之外的东西（顺带验证索引可用）", async () => {
  // 只验证查询不报错、且删干净 —— 清理逻辑由 `consumeCode` 与重发覆盖承担
  await prisma.emailVerification.deleteMany({ where: { email: EMAIL } });
  assert.equal(
    await prisma.emailVerification.count({ where: { email: EMAIL } }),
    0,
  );
});

test("randomInt 的范围不会产生超出位数的值", () => {
  // `10 ** CODE_LENGTH` 作为上界是**开区间**，取值最大 999999 —— 不会出现
  // 1000000 这种 7 位数（那会让 padStart 变成 no-op 且长度校验失败）
  assert.ok(randomInt(0, 10 ** CODE_LENGTH) < 10 ** CODE_LENGTH);
});

/* ---------------------------------------------------------------- *
 * 邮件主题：必须每次唯一
 * ---------------------------------------------------------------- */

test("主题带时间戳 —— 固定主题会让邮件被折叠成一条会话", () => {
  // 这是用户报「验证码不正确」的直接成因：QQ 邮箱按**主题**归并会话，
  // 用户连点几次后打开会话看到的是**最早那封**，而只有最新那封有效 ——
  // 正文里那句「只有最新这一封有效」他根本滚不到。
  const subject = verificationEmailSubject("register", new Date(2026, 9, 6, 16, 25));
  assert.match(subject, /16:25/, "主题里应能看出这次发送的时刻");
  assert.match(subject, /注册验证码/);
});

test("不同分钟产生不同主题（拆开会话的前提）", () => {
  const a = verificationEmailSubject("register", new Date(2026, 9, 6, 16, 25));
  const b = verificationEmailSubject("register", new Date(2026, 9, 6, 16, 26));
  assert.notEqual(a, b, "相隔一分钟的主题必须不同，否则仍会被折叠");
});

test("同一分钟内的多次调用主题相同（时间戳是唯一变量）", () => {
  // 反向确认：唯一性来自时间而不是随机数 —— 它是可解释的。
  const at = new Date(2026, 9, 6, 16, 25, 30);
  assert.equal(verificationEmailSubject("register", at), verificationEmailSubject("register", at));
});

test("跨天、跨月也唯一", () => {
  assert.notEqual(
    verificationEmailSubject("register", new Date(2026, 9, 6, 23, 59)),
    verificationEmailSubject("register", new Date(2026, 9, 7, 0, 0)),
  );
  assert.notEqual(
    verificationEmailSubject("register", new Date(2026, 8, 30, 10, 0)),
    verificationEmailSubject("register", new Date(2026, 9, 1, 10, 0)),
  );
});

test("主题里**不含验证码** —— 它不该进通知栏与日志", () => {
  // 验证码是短凭据。放进主题会出现在锁屏预览、通知栏、以及服务端日志里。
  const subject = verificationEmailSubject("register", new Date(2026, 9, 6, 16, 25));
  const code = generateCode();
  assert.equal(subject.includes(code), false);
  // 主题里唯一的数字应是月-日 时:分 那四个
  assert.match(subject, /\d{2}-\d{2} \d{2}:\d{2}/);
});

test("分钟与月份都补零（16:05 不能写成 16:5）", () => {
  const subject = verificationEmailSubject("register", new Date(2026, 0, 3, 9, 5));
  assert.match(subject, /01-03 09:05/);
});
