/**
 * 注册邮箱验证码的签发与校验。
 *
 * ## 安全取舍
 *
 * 验证码是 6 位数字 —— 空间只有 10^6，**在线穷举是真实威胁**。因此：
 *
 * 1. **尝试次数上限**（5 次）后作废，否则可以对同一邮箱试满 100 万次；
 * 2. **重发即覆盖**：同一邮箱同时只有一个有效码，不留历史有效凭据；
 * 3. **存散列不存明文**：数据库被读走时，明文码等于一次注册机会
 *    （复用 `hashPassword`，与用户口令同一套 scrypt）；
 * 4. **60 秒重发间隔**：`EmailVerification` 每邮箱只有一行，节流靠它自己的
 *    `sentAt`；按 IP 的轰炸防护在接口层用令牌桶（见 `send-code` 路由）。
 *
 * ## 为什么抽成纯逻辑 + 一层薄持久化
 *
 * 上面每一条都是**静默失效**的类型 —— 写错了不报错，只是保护没了。
 * 判定用可测的形式表达，行为用测试钉住。
 */

import { randomInt } from "node:crypto";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";

/** 验证码位数。6 位 + 5 次尝试上限 = 命中概率 ≤ 5×10^-6。 */
export const CODE_LENGTH = 6;

/** 有效期。太长给攻击者时间，太短用户来不及抄。 */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** 同一邮箱两次发送之间的最小间隔。 */
export const RESEND_INTERVAL_MS = 60 * 1000;

/** 单个验证码的最大尝试次数，超过即作废、必须重新发送。 */
export const MAX_ATTEMPTS = 5;

/** 唯一用途。将来加「找回密码」时再扩。 */
const PURPOSE = "register";

/**
 * 生成验证码。
 *
 * 用 `crypto.randomInt` 而不是 `Math.random()` —— 后者可预测，而验证码是
 * 安全凭据。`randomInt(0, 10^6)` 的取值是均匀的（`% 1000000` 会有模偏差）。
 */
export function generateCode(length = CODE_LENGTH): string {
  return String(randomInt(0, 10 ** length)).padStart(length, "0");
}

/**
 * 邮箱归一化。
 *
 * 统一转小写：域名大小写不敏感，本地部分理论上敏感但实践中不是。
 * 不归一化的话 `A@x.com` 与 `a@x.com` 会各拿一个验证码，
 * 「重发即覆盖」随之失效。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 验证码邮件的**主题**。
 *
 * ## 为什么必须每次唯一
 *
 * 邮件客户端（QQ 邮箱尤其）按**主题**归并会话。主题固定时，用户连点几次
 * 「发送验证码」得到的几封会被折叠成**一条会话**，而打开会话看到的是
 * **最早那封** —— 但只有最新那封有效。
 *
 * 于是即使用正文写了「只有最新这一封有效」，用户也**滚不到那句话**，
 * 仍然照着旧码填，得到「验证码不正确」而看不出原因。
 * 这个提示**救不了**那个失败模式 —— 拆开会话才能救。
 *
 * 带上「月-日 时:分」后每封都是独立会话，最新那封自然在最上面。
 *
 * ## 为什么不用验证码本身当标记
 *
 * 验证码出现在主题里会进入通知栏、锁屏预览、以及服务端日志 ——
 * 那是一个短凭据不该去的地方。时间戳同样能唯一化，且不泄露任何东西。
 *
 * 分钟粒度足够：重发有 60 秒节流，两次发送必然跨分钟。
 */
export function verificationEmailSubject(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `hit-ani 注册验证码 ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

export type VerifyOutcome =
  | "ok"
  | "invalid"
  | "expired"
  | "too-many-attempts"
  | "missing";

/**
 * 校验验证码。
 *
 * 返回**原因**而不是布尔值：调用方需要区分「没发过码」（提示去发送）与
 * 「码错了」（提示重试），而这不会泄露给攻击者任何有用信息 ——
 * `invalid` 与 `missing` 都只说明「这次输入不对」。
 */
export async function verifyCode(email: string, code: string): Promise<VerifyOutcome> {
  const key = { email: normalizeEmail(email), purpose: PURPOSE };
  const row = await prisma.emailVerification.findUnique({
    where: { email_purpose: key },
  });
  if (!row) return "missing";

  if (row.expiresAt.getTime() < Date.now()) return "expired";
  if (row.attempts >= MAX_ATTEMPTS) return "too-many-attempts";

  if (!(await verifyPassword(code, row.codeHash))) {
    // 失败必须计数，否则「5 次上限」形同虚设
    await prisma.emailVerification.update({
      where: { email_purpose: key },
      data: { attempts: { increment: 1 } },
    });
    return "invalid";
  }

  return "ok";
}

/** 校验通过后删除记录 —— 一次性，不能拿去注册第二个账号。 */
export async function consumeCode(email: string): Promise<void> {
  await prisma.emailVerification.deleteMany({
    where: { email: normalizeEmail(email), purpose: PURPOSE },
  });
}

export type IssueOutcome =
  | { ok: true; code: string }
  | { ok: false; reason: "throttled"; retryAfterMs: number };

/**
 * 签发并**落库**一个验证码（不负责发信 —— 发信由调用方做）。
 *
 * 顺序是**先落库再发信**：反过来的话，「发信成功但落库失败」会让用户
 * 收到一个永远校验不过的码。现在的最坏情况是「库里有个没发出去的码」——
 * 用户重发即覆盖，无害。
 *
 * 重发会**重置 attempts 与过期时间**：旧码随之彻底失效，不留后门。
 */
export async function issueCode(
  email: string,
  sentFromIp: string | null,
): Promise<IssueOutcome> {
  const normalized = normalizeEmail(email);
  const key = { email: normalized, purpose: PURPOSE };
  const now = Date.now();

  const existing = await prisma.emailVerification.findUnique({
    where: { email_purpose: key },
    select: { sentAt: true },
  });

  if (existing) {
    const since = now - existing.sentAt.getTime();
    if (since < RESEND_INTERVAL_MS) {
      return { ok: false, reason: "throttled", retryAfterMs: RESEND_INTERVAL_MS - since };
    }
  }

  const code = generateCode();
  const codeHash = await hashPassword(code);
  const fields = {
    codeHash,
    attempts: 0,
    expiresAt: new Date(now + CODE_TTL_MS),
    sentAt: new Date(now),
    sentFromIp,
  };

  await prisma.emailVerification.upsert({
    where: { email_purpose: key },
    create: { email: normalized, purpose: PURPOSE, ...fields },
    update: fields,
  });

  return { ok: true, code };
}
