/**
 * 发送频率限制（令牌桶）。
 *
 * 对齐 Animeko「每条弹幕绑定账号以防滥用」的做法：单进程内存实现，
 * 多实例部署时应换成 Redis；接口保持 `consume()` 语义不变。
 */

export interface RateLimitRule {
  /** 桶容量 = 允许的突发条数。 */
  capacity: number;
  /** 每秒补充的令牌数。 */
  refillPerSecond: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 被拒时建议的等待毫秒数。 */
  retryAfterMs: number;
  /** 剩余可用令牌（向下取整）。 */
  remaining: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const DEFAULT_RULE: RateLimitRule = { capacity: 5, refillPerSecond: 0.5 };

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: RateLimitRule = DEFAULT_RULE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 消耗一个令牌。纯内存操作，O(1)。 */
  consume(key: string): RateLimitDecision {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.rule.capacity,
      updatedAt: t,
    };

    const elapsedMs = Math.max(0, t - bucket.updatedAt);
    const refilled = bucket.tokens + (elapsedMs / 1000) * this.rule.refillPerSecond;
    const tokens = Math.min(this.rule.capacity, refilled);

    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: t });
      const deficit = 1 - tokens;
      return {
        allowed: false,
        retryAfterMs: Math.ceil((deficit / this.rule.refillPerSecond) * 1000),
        remaining: 0,
      };
    }

    const next = tokens - 1;
    this.buckets.set(key, { tokens: next, updatedAt: t });
    return { allowed: true, retryAfterMs: 0, remaining: Math.floor(next) };
  }

  /** 回收长期不活跃的桶，避免内存无界增长。 */
  prune(idleMs = 10 * 60 * 1000): void {
    const cutoff = this.now() - idleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** 进程级默认限流器：每人 5 条突发，之后 30 秒 1 条。 */
export const danmakuRateLimiter = new TokenBucketLimiter();
