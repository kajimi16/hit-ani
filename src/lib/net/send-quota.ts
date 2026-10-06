/**
 * 发码限流策略 —— 两道限流的**判定顺序**是一条安全不变量。
 *
 * ## 不变量的内容
 *
 * > **全局那道必须先判，且全局拒绝时短路，不再判 IP 那道。**
 *
 * ## 为什么顺序不能反
 *
 * `X-Forwarded-For` 是客户端可伪造的：实测确认 Next **直接透传**该头
 * （伪造 `9.9.9.1` 后服务端看到的就是 `9.9.9.1`），于是伪造它即可每次都是
 * 「新 IP」—— 实测不伪造时第 6 次被 429，伪造后**连续 8 次全部通过**。
 *
 * 因此真正拦得住的是与请求头无关的**全局**那道。若顺序写反：
 *
 * 1. 能连上的攻击者先被 IP 那道拦住（伪造头即可绕过），**全局那道根本没机会
 *    生效** —— 看起来仍在限流，实际已可无限刷。这是**修复静默失效**，
 *    不会报错、不会有日志，只有测试能抓。
 * 2. 被全局挡下的请求还会白白消耗该 IP 的配额，等全局恢复后用户得再等一轮。
 *
 * 抽成纯函数就是为了让这条顺序能被断言 —— 它改错时没有任何外在表现。
 */

import type { TokenBucketLimiter } from "@/lib/danmaku/rate-limit";

export type SendQuotaVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** 是哪一道拦下的 —— 决定给用户的文案。 */
      scope: "global" | "ip";
      retryAfterMs: number;
    };

export interface SendLimiters {
  /** 与请求头无关的全局限流。**主防线**。 */
  global: TokenBucketLimiter;
  /** 按 IP 的补充限流。可被伪造的 `X-Forwarded-For` 绕过，因此只作补充。 */
  perIp: TokenBucketLimiter;
}

/**
 * 消耗一次发码配额。
 *
 * 顺序：**全局 → IP**，全局拒绝时短路（不再消耗 IP 桶）。
 */
export function consumeSendQuota(limiters: SendLimiters, ip: string): SendQuotaVerdict {
  // ⚠️ 这两行的先后不可颠倒，见文件头
  const global = limiters.global.consume("all");
  if (!global.allowed) {
    return { allowed: false, scope: "global", retryAfterMs: global.retryAfterMs };
  }

  const perIp = limiters.perIp.consume(ip);
  if (!perIp.allowed) {
    return { allowed: false, scope: "ip", retryAfterMs: perIp.retryAfterMs };
  }

  return { allowed: true };
}

/** 两道限流的 429 文案 —— 与 `scope` 一一对应，措辞上区分「全局」与「本机」。 */
export function quotaMessage(verdict: Extract<SendQuotaVerdict, { allowed: false }>): string {
  const seconds = Math.ceil(verdict.retryAfterMs / 1000);
  return verdict.scope === "global"
    ? `发送过于频繁，请 ${seconds} 秒后再试`
    : `请求过于频繁，请 ${seconds} 秒后再试`;
}
