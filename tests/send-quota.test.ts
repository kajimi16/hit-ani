/**
 * 发码限流策略的测试。
 *
 * ## 锁的是一条安全不变量，而不是普通业务逻辑
 *
 * > **全局那道必须先判，且全局拒绝时短路。**
 *
 * 因为 `X-Forwarded-For` 可被伪造（实测：Next 直接透传该头，伪造后连续 8 次
 * 请求全部通过），IP 那道**不算防线** —— 真正拦得住的是与请求头无关的全局那道。
 *
 * 顺序写反的后果不是「报错」，而是**修复静默失效**：攻击者被伪造头绕过了
 * IP 那道，而全局那道根本没被调用。看起来仍在限流。这种回归只有测试能抓。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TokenBucketLimiter } from "@/lib/danmaku/rate-limit";
import { consumeSendQuota, quotaMessage } from "@/lib/net/send-quota";

/** 可控时钟的限流器 —— 时间不动，因此不会自动回填。 */
function limiter(capacity: number, refillPerSecond = 0) {
  let now = 0;
  const instance = new TokenBucketLimiter({ capacity, refillPerSecond }, () => now);
  return { instance, advance: (ms: number) => (now += ms) };
}

test("两道都有额度时放行", () => {
  const verdict = consumeSendQuota(
    { global: limiter(3).instance, perIp: limiter(3).instance },
    "1.1.1.1",
  );
  assert.equal(verdict.allowed, true);
});

test("全局先于 IP：全局耗尽时立刻短路，**不消耗** IP 桶", () => {
  // 这条是本文件的核心。若顺序写反，被全局挡下的请求还会吃掉该 IP 的配额 ——
  // 等全局恢复后用户还得再等一轮。
  const global = limiter(1);
  const perIp = limiter(5);
  const limiters = { global: global.instance, perIp: perIp.instance };

  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true); // 全局 1 → 0
  const denied = consumeSendQuota(limiters, "1.1.1.1"); // 全局 0 → 拒
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.scope, "global");

  // IP 桶应当**一个都没被消耗** —— 用另一个 IP 验证它仍有满额 5 个
  for (let i = 0; i < 5; i += 1) {
    assert.equal(
      consumeSendQuota({ global: limiter(1).instance, perIp: perIp.instance }, "2.2.2.2").allowed,
      true,
      `第 ${i + 1} 次不该被 IP 那道拦下 —— 说明前面的全局拒绝消耗了 IP 配额`,
    );
  }
});

test("IP 那道耗尽时拒绝，且 `scope` 标为 ip（决定文案）", () => {
  const verdict = (() => {
    const global = limiter(100);
    const perIp = limiter(1);
    const limiters = { global: global.instance, perIp: perIp.instance };
    consumeSendQuota(limiters, "1.1.1.1");
    return consumeSendQuota(limiters, "1.1.1.1");
  })();

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.allowed === false && verdict.scope, "ip");
});

test("IP 桶按 IP 隔离 —— 换 IP 不受影响", () => {
  // 这是 IP 限流本来该有的行为（尽管它可被伪造绕过）
  const global = limiter(100);
  const perIp = limiter(1);
  const limiters = { global: global.instance, perIp: perIp.instance };

  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true);
  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, false);
  assert.equal(consumeSendQuota(limiters, "3.3.3.3").allowed, true, "另一个 IP 应仍有额度");
});

test("全局是**全局**的：伪造 IP 不能绕过它", () => {
  // 直接对着用户报障的形态：`X-Forwarded-For` 伪造出源源不断的「新 IP」。
  // 全局那道与 IP 无关，因此伪造头对它无效。
  const global = limiter(3);
  const perIp = limiter(100);
  const limiters = { global: global.instance, perIp: perIp.instance };

  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < 10; i += 1) {
    // 每次都是「新 IP」
    const verdict = consumeSendQuota(limiters, `9.9.${i}.${i}`);
    if (verdict.allowed) allowed += 1;
    else denied += 1;
  }

  assert.equal(allowed, 3, "全局容量为 3，只应放行 3 次");
  assert.equal(denied, 7, "其余应被全局那道拦下 —— 换 IP 不能绕过");
});

test("全局拒绝时的 retryAfterMs 被如实传出（用于文案）", () => {
  const global = limiter(1, 1); // 每秒回填 1 个
  const limiters = { global: global.instance, perIp: limiter(100).instance };
  consumeSendQuota(limiters, "1.1.1.1");

  const denied = consumeSendQuota(limiters, "1.1.1.1");
  assert.equal(denied.allowed, false);
  if (denied.allowed) return;
  assert.ok(denied.retryAfterMs > 0, "应给出还需等待多久");
  assert.ok(denied.retryAfterMs <= 1000, "回填速率 1/秒，等待不该超过 1 秒");
});

test("额度随时间恢复后重新放行", () => {
  const global = limiter(1, 1); // 每秒回填 1
  const limiters = { global: global.instance, perIp: limiter(100).instance };

  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true);
  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, false);

  global.advance(1500);
  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true, "回填后应恢复");
});

/* ---------------------------------------------------------------- *
 * 文案
 * ---------------------------------------------------------------- */

test("两种 scope 的文案不同 —— 用户能分辨「全局繁忙」与「你太快了」", () => {
  const globalMsg = quotaMessage({ allowed: false, scope: "global", retryAfterMs: 5000 });
  const ipMsg = quotaMessage({ allowed: false, scope: "ip", retryAfterMs: 5000 });

  assert.notEqual(globalMsg, ipMsg);
  assert.match(globalMsg, /发送过于频繁/);
  assert.match(ipMsg, /请求过于频繁/);
});

test("文案里的秒数向上取整（不显示「请 0 秒后再试」）", () => {
  for (const ms of [1, 500, 999, 1000, 1001, 2500]) {
    const msg = quotaMessage({ allowed: false, scope: "global", retryAfterMs: ms });
    const seconds = Number(/请 (\d+) 秒/.exec(msg)?.[1]);
    assert.ok(seconds >= 1, `${ms}ms 得出「${msg}」`);
  }
});
