/**
 * Bangumi 令牌的**展示用**状态计算。
 *
 * ## 为什么单独一个模块
 *
 * 设置在客户端组件里渲染，因此这里**不能**依赖 prisma / `bgm-oauth.ts`
 * （后者 `import { prisma }`，被客户端组件引用会直接把服务端代码拖进 bundle）。
 *
 * 同时它是纯函数——「还剩多久算将过期」这类边界必须能被直接断言，
 * 而界面上「令牌过期了却没有更新入口」正是这次要修的那个 bug。
 */

/** 一天。阈值与 `bgm-oauth.ts` 的刷新窗口保持一致（24 小时）。 */
export const TOKEN_WARN_MS = 24 * 60 * 60 * 1000;

export type BgmTokenStatus =
  /** 无从得知（没有绑定，或绑定没有记录过期时间）。**不要**据此提示用户。 */
  | "unknown"
  /** 有效期充足。 */
  | "ok"
  /** 即将过期（≤ 24 小时）。 */
  | "expiring"
  /** 已经过期。 */
  | "expired";

export interface BgmTokenStatusInfo {
  status: BgmTokenStatus;
  /** 剩余天数（向上取整）；已过期时为 0 或负数。`unknown` 时为 null。 */
  daysLeft: number | null;
}

/**
 * 按过期时刻计算展示状态。
 *
 * `expiresAtMs` 用毫秒时间戳（而非 `Date`）—— 它要穿过服务端组件 →
 * 客户端组件的边界，时间戳是最不容易在序列化上出岔子的形式。
 */
export function bgmTokenStatus(expiresAtMs: number | null, now = Date.now()): BgmTokenStatusInfo {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) {
    return { status: "unknown", daysLeft: null };
  }

  const remaining = expiresAtMs - now;
  const daysLeft = Math.ceil(remaining / TOKEN_WARN_MS);

  if (remaining <= 0) return { status: "expired", daysLeft };
  if (remaining <= TOKEN_WARN_MS) return { status: "expiring", daysLeft };
  return { status: "ok", daysLeft };
}
