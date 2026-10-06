/**
 * 「取来源 IP」的测试。
 *
 * ## 防的是什么
 *
 * 这个值用来限流，而它**可以被一条请求头伪造**。实测确认：Next 会直接透传
 * 客户端发的 `X-Forwarded-For`（伪造 `9.9.9.1` 后服务端看到的就是 `9.9.9.1`，
 * 没有追加真实地址）。因此：
 *
 * 1. 取**第一跳**会让「伪造即绕过」（不伪造时第 6 次被拦，伪造后连续 8 次全过）；
 * 2. 取**最后一跳**至少在「客户端伪造 + 自己代理追加」的形态下拿到真实值；
 * 3. 但**直连时仍然可伪造** —— 所以这不是安全边界，调用方必须另有
 *    与请求头无关的兜底限流。这一点写在模块注释里。
 *
 * 这些断言锁住「取哪一跳」这个决定 —— 它改错时不会有任何报错，
 * 只表现为限流悄悄失效。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { clientIp } from "@/lib/net/client-ip";

/** 造一个最小 headers 替身。 */
function headers(map: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

test("没有代理头时用 x-real-ip", () => {
  assert.equal(clientIp(headers({ "x-real-ip": "10.1.2.3" })), "10.1.2.3");
});

test("两个头都没有时返回 unknown（而不是空串）", () => {
  // 空串会让所有请求共用一个「空」键，看起来像限流生效但实际语义不明；
  // `unknown` 至少是可辨认的常量。
  assert.equal(clientIp(headers({})), "unknown");
});

test("单跳时取那一个值", () => {
  assert.equal(clientIp(headers({ "x-forwarded-for": "10.0.0.5" })), "10.0.0.5");
});

test("多跳时取**最后一跳** —— 那才是自己代理追加的真实客户端", () => {
  // 形如 `<客户端伪造的>, <真实客户端>`：取第一个就拿到伪造值，限流被绕过。
  assert.equal(clientIp(headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.7" })), "10.0.0.7");
  assert.equal(
    clientIp(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 10.0.0.7" })),
    "10.0.0.7",
  );
});

test("容忍空格与空项，不会把空串当成 IP", () => {
  // `" 10.0.0.1 , "` 这种形态在真实代理配置里很常见
  assert.equal(clientIp(headers({ "x-forwarded-for": "  10.0.0.1  ,  " })), "10.0.0.1");
  assert.equal(clientIp(headers({ "x-forwarded-for": ",,10.0.0.2,," })), "10.0.0.2");
  // 全是空项时退回 x-real-ip，而不是返回空串
  assert.equal(clientIp(headers({ "x-forwarded-for": ",,", "x-real-ip": "10.0.0.3" })), "10.0.0.3");
});

test("伪造单跳值**确实**能拿到那个伪造值 —— 这不是安全边界", () => {
  // 明确记录这个已知局限：直连部署下伪造 XFF 就能让每次请求看起来来自不同 IP。
  // 因此 send-code 路由另有与请求头无关的**全局**限流作为主防线。
  assert.equal(clientIp(headers({ "x-forwarded-for": "9.9.9.9" })), "9.9.9.9");
});
