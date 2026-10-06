/**
 * 发码限流策略的测试。
 *
 * ## 锁的是一条安全不变量，而不是普通业务逻辑
 *
 * > **全局那道必须先判，且全局拒绝时短路（不再消耗 IP 桶）。**
 *
 * 因为 `X-Forwarded-For` 可被伪造（实测：Next 直接透传该头，伪造后连续 8 次
 * 请求全部通过），IP 那道**不算防线** —— 真正拦得住的是与请求头无关的全局那道。
 *
 * 顺序写反的后果不是「报错」，而是**修复静默失效**：攻击者被伪造头绕过了
 * IP 那道，而全局那道根本没被调用。看起来仍在限流。这种回归只有测试能抓。
 *
 * ## ⚠️ 测这条不变量必须让**两道都耗尽**
 *
 * 第一版测试只耗尽了全局那道（IP 那道容量给到 5/100），于是调换顺序后
 * **9/9 仍然通过** —— 因为两道都有余量时，谁先判都会放行，`scope` 也仍然是
 * `global`（全局空着照样会拒）。
 *
 * 判别性的用例必须构造成：**两道都会拒**，然后断言**是哪一道**报出来的。
 * 这就是「测试名与断言不符」的典型 —— 名字写着「先于」，断言却抓不到。
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

/* ================================================================== *
 * 顺序不变量 —— 判别性用例
 * ================================================================== */

test("两道都会拒时，报出的必须是 `global`（证明全局先判）", () => {
  // 这是本文件的核心用例。**必须让两道都空** —— 只有此时「谁先判」才可观测：
  //   - 正确顺序：全局先拒 → scope = "global"
  //   - 顺序颠倒：IP 先拒   → scope = "ip"
  const global = limiter(1);
  const perIp = limiter(1);
  const limiters = { global: global.instance, perIp: perIp.instance };

  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true); // 两道各消耗到 0

  const denied = consumeSendQuota(limiters, "1.1.1.1");
  assert.equal(denied.allowed, false);
  assert.equal(
    denied.allowed === false && denied.scope,
    "global",
    "两道都空时报的是 IP 那道 —— 说明顺序颠倒了，全局那道没被优先检查",
  );
});

test("全局拒绝时**不消耗** IP 桶 —— 短路的两重意义", () => {
  // 短路的第一个意义是安全性（顺序），第二个是「不白白吃掉用户配额」。
  // 直接观测：全局拒绝若干次后，该 IP 的桶仍应剩满额。
  const global = limiter(1);
  const perIp = limiter(3);
  const limiters = { global: global.instance, perIp: perIp.instance };

  // 第 1 次：两道各消耗一次 → global 0，perIp 3→2
  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true);

  // 接下来 5 次都被全局挡下。若顺序颠倒，这 5 次会把 perIp 耗光。
  for (let i = 0; i < 5; i += 1) {
    const verdict = consumeSendQuota(limiters, "1.1.1.1");
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.allowed === false && verdict.scope, "global");
  }

  // 现在换一个**额度充足**的全局（模拟全局恢复），该 IP 应还剩 2 次额度。
  const freshGlobal = limiter(99);
  const recovered = { global: freshGlobal.instance, perIp: perIp.instance };

  assert.equal(consumeSendQuota(recovered, "1.1.1.1").allowed, true, "应还剩第 1 次");
  assert.equal(consumeSendQuota(recovered, "1.1.1.1").allowed, true, "应还剩第 2 次");

  const exhausted = consumeSendQuota(recovered, "1.1.1.1");
  assert.equal(exhausted.allowed, false, "第 3 次才该耗尽（说明前面被全局挡下时没吃 IP 配额）");
  assert.equal(exhausted.allowed === false && exhausted.scope, "ip");
});

test("全局是**全局**的：伪造 IP 不能绕过它", () => {
  // 直接对着用户报障的形态：`X-Forwarded-For` 伪造出源源不断的「新 IP」。
  // 全局那道与 IP 无关，因此伪造头对它无效。
  //
  // IP 那道容量给得足够大 —— 这样「放行几次」完全由全局决定。
  const global = limiter(3);
  const perIp = limiter(1000);
  const limiters = { global: global.instance, perIp: perIp.instance };

  let allowed = 0;
  let denied = 0;
  for (let i = 0; i < 10; i += 1) {
    const verdict = consumeSendQuota(limiters, `9.9.${i}.${i}`);
    if (verdict.allowed) allowed += 1;
    else denied += 1;
  }

  assert.equal(allowed, 3, "全局容量为 3，只应放行 3 次");
  assert.equal(denied, 7, "其余应被全局那道拦下 —— 换 IP 不能绕过");
});

/* ================================================================== *
 * 其它行为
 * ================================================================== */

test("IP 桶按 IP 隔离 —— 换 IP 不受影响", () => {
  // IP 限流本来该有的行为（尽管它可被伪造绕过）
  const global = limiter(100);
  const perIp = limiter(1);
  const limiters = { global: global.instance, perIp: perIp.instance };

  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, true);
  assert.equal(consumeSendQuota(limiters, "1.1.1.1").allowed, false);
  assert.equal(consumeSendQuota(limiters, "3.3.3.3").allowed, true, "另一个 IP 应仍有额度");
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
