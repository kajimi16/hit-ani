/**
 * 带 TTL 与 LRU 淘汰的小型缓存。
 *
 * ## 为什么需要它
 *
 * 外部弹幕按集缓存，实测 **0.92 MB/集**。若只按时间过期、不做容量限制，
 * 常驻进程（弹幕网关）会随访问过的集数持续增长 —— 跑几周就是几百 MB。
 *
 * 抽成独立模块而不是内联在使用处，是为了**能被单测直接验证**：
 * 淘汰逻辑是这次修复的核心，改坏了必须有测试失败。
 *
 * ## 实现说明
 *
 * 用 `Map` 而非引入依赖：`Map` 保持插入顺序，因此
 * 「删除后重新插入」即把条目移到末尾表示最近使用，
 * 淘汰时删最前面那个。对本场景足够，也少一个依赖。
 */

export interface LruCacheOptions {
  /** 最大条目数。超出时淘汰最久未使用的。 */
  maxSize: number;
  /** 条目存活时长（毫秒）。 */
  ttlMs: number;
  /** 注入时钟，便于测试 TTL 行为。 */
  now?: () => number;
}

export class TtlLruCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  /** 累计淘汰次数，供运维观察（持续增长说明容量不够）。 */
  private evictions = 0;

  constructor(options: LruCacheOptions) {
    if (options.maxSize <= 0) throw new Error("maxSize 必须为正数");
    if (options.ttlMs <= 0) throw new Error("ttlMs 必须为正数");
    this.maxSize = options.maxSize;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** 读取；命中时刷新其「最近使用」位置。过期条目视为未命中并删除。 */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    // 删了重插 = 移到末尾，标记为最近使用
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** 写入，并按需淘汰最久未使用的条目。 */
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });

    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** 累计淘汰次数。 */
  get evictionCount(): number {
    return this.evictions;
  }
}
