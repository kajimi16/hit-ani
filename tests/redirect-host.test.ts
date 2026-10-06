/**
 * OAuth 回调 host 一致性检查测试。
 *
 * ## 防的是什么
 *
 * state Cookie 是 **host-only** —— 浏览器只把它发给签发它的那个 host。
 * 若「用户访问的 host」与「`BGM_REDIRECT_URI` 的 host」不同，回调请求里不带
 * 这个 Cookie，校验必然失败。
 *
 * 用户看到的是「状态校验失败（不匹配或已过期）」—— 那个提示把原因归到
 * 「停留太久 / Cookie 没保留」，**完全没说中**。而本项目用局域网 IP 访问、
 * 回调地址又必须在 bgm.tv 上登记成固定值，所以这个错配很常见
 * （实测 IP 换过一次：`10.249.61.10` → `192.168.6.203`）。
 *
 * 因此判定必须准确：放行不该放行的会让用户白跑一趟；拦下不该拦的会
 * 让绑定彻底用不了。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRedirectHost } from "@/lib/auth/redirect-host";

test("host 相同时放行", () => {
  assert.equal(
    checkRedirectHost("http://192.168.6.203:3100", "http://192.168.6.203:3100/api/auth/bgm/callback")
      .ok,
    true,
  );
});

test("协议不同但 host 相同 → 放行", () => {
  // host-only Cookie 不看协议：http 与 https 共用同一个 host 的 Cookie 域。
  // 本项目在明文 HTTP 上跑，而回调可能被登记成 https —— 拦下它会让功能
  // 彻底不可用，而实际是能工作的。
  assert.equal(
    checkRedirectHost("http://example.com", "https://example.com/api/auth/bgm/callback").ok,
    true,
  );
});

test("host 不同 → 拦下，并说清两个 host 各是什么", () => {
  const verdict = checkRedirectHost(
    "http://192.168.6.203:3100",
    "http://localhost:3100/api/auth/bgm/callback",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.browsing, "192.168.6.203:3100");
  assert.equal(verdict.registered, "localhost:3100");
  // 说明里必须同时出现两个 host，用户才能自己判断该改哪一边
  assert.match(verdict.message, /192\.168\.6\.203:3100/);
  assert.match(verdict.message, /localhost:3100/);
});

test("端口不同也算不同 host —— 这正是本项目最容易踩的形态", () => {
  // 同一台机器上换端口访问（3100 vs 3000）也会让 Cookie 带不过去
  const verdict = checkRedirectHost("http://192.168.6.203:3000", "http://192.168.6.203:3100/cb");
  assert.equal(verdict.ok, false);
});

test("大小写不敏感", () => {
  assert.equal(
    checkRedirectHost("http://EXAMPLE.com:3100", "http://example.com:3100/cb").ok,
    true,
  );
});

test("说明里给出可执行的两种解决办法，而不是只说「不一致」", () => {
  const verdict = checkRedirectHost("http://a.test:1", "http://b.test:2/cb");
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.message, /改用/, "应提示换个地址访问");
  assert.match(verdict.message, /BGM_REDIRECT_URI/, "应提示改环境变量");
  assert.match(verdict.message, /逐字符/, "应提醒两处必须完全一致");
});

test("解析不出 host 时放行（辅助检查不该把功能锁死）", () => {
  // 真正的一致性最终由 bgm.tv 与浏览器 Cookie 语义兜底；
  // 这里因为意外输入而拦下，会把可用功能变成不可用。
  for (const bad of ["", "not-a-url", "://missing-scheme"]) {
    assert.equal(checkRedirectHost(bad, "http://x.test/cb").ok, true, `browsing=${bad}`);
    assert.equal(checkRedirectHost("http://x.test", bad).ok, true, `redirect=${bad}`);
  }
});

test("IPv6 与带端口的 host 都能正确比较", () => {
  assert.equal(checkRedirectHost("http://[::1]:3100", "http://[::1]:3100/cb").ok, true);
  assert.equal(checkRedirectHost("http://[::1]:3100", "http://[::1]:3101/cb").ok, false);
});
