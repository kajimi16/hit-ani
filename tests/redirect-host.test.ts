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

test("主机名相同时放行", () => {
  assert.equal(
    checkRedirectHost("192.168.6.203:3100", "http://192.168.6.203:3100/api/auth/bgm/callback").ok,
    true,
  );
});

test("主机名不同 → 拦下（实测确认 Cookie 只发给签发它的主机名）", () => {
  const verdict = checkRedirectHost("192.168.6.203:3100", "http://localhost:3100/api/auth/bgm/callback");
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.equal(verdict.browsing, "192.168.6.203:3100");
  assert.equal(verdict.registered, "localhost:3100");
});

test("传入 null（拿不到 Host 头）时放行 —— 辅助检查不该把功能锁死", () => {
  assert.equal(checkRedirectHost(null, "http://anything.test/cb").ok, true);
});

test("协议不同但主机名相同 → 放行（Cookie 不看协议）", () => {
  assert.equal(checkRedirectHost("example.com:443", "https://example.com/cb").ok, true);
});

test("说明里同时给出两个地址，用户才能判断该改哪一边", () => {
  const verdict = checkRedirectHost(
    "192.168.6.203:3100",
    "http://localhost:3100/api/auth/bgm/callback",
  );
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.message, /192\.168\.6\.203:3100/);
  assert.match(verdict.message, /localhost:3100/);
});

test("端口不同**不**算不匹配 —— Cookie 作用域只看主机名", () => {
  // 这条是被实测纠正的：上一版比较 host:port，会误拦能用的配置。
  // RFC 6265 里 Cookie 的作用域不含端口，实测确认：
  // 在 localhost:3100 设置的 Cookie，访问 localhost:3210 时照样发送。
  assert.equal(
    checkRedirectHost("192.168.6.203:3000", "http://192.168.6.203:3100/cb").ok,
    true,
  );
  assert.equal(checkRedirectHost("localhost:3199", "http://localhost:3100/cb").ok, true);
});

test("大小写不敏感", () => {
  assert.equal(checkRedirectHost("EXAMPLE.com:3100", "http://example.com:3100/cb").ok, true);
});

test("说明里给出可执行的两种解决办法，而不是只说「不一致」", () => {
  const verdict = checkRedirectHost("a.test:1", "http://b.test:2/cb");
  assert.equal(verdict.ok, false);
  if (verdict.ok) return;
  assert.match(verdict.message, /改用/, "应提示换个地址访问");
  assert.match(verdict.message, /BGM_REDIRECT_URI/, "应提示改环境变量");
  assert.match(verdict.message, /逐字符/, "应提醒两处必须完全一致");
});

test("解析不出地址时放行（辅助检查不该把功能锁死）", () => {
  for (const bad of ["", "not a url", "://x", "a/b"]) {
    assert.equal(checkRedirectHost(bad, "http://x.test/cb").ok, true, `browsing=${bad}`);
    assert.equal(checkRedirectHost("x.test", bad).ok, true, `redirect=${bad}`);
  }
});

test("IPv6 字面量能正确解析（端口不参与比较）", () => {
  assert.equal(checkRedirectHost("[::1]:3100", "http://[::1]:3100/cb").ok, true);
  assert.equal(checkRedirectHost("[::1]:3199", "http://[::1]:3100/cb").ok, true);
  assert.equal(checkRedirectHost("[::1]:3100", "http://[::2]:3100/cb").ok, false);
});
