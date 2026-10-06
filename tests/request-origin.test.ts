/**
 * 解析「浏览器侧 origin」的测试。
 *
 * ## 防的是什么
 *
 * 实测（Next 15、真实容器）：`request.url` 的 host 是**服务器自己的监听地址**，
 * 完全无视 `Host` 头：
 *
 *     Host: 192.168.6.203:3100  →  request.url.origin = http://localhost:3100
 *
 * 后果是用户可见的：所有用 `url.origin` 拼的重定向都把浏览器送到
 * `localhost:3100` —— **用户自己那台机器**。BGM / QQ 回调完成后就会这样。
 *
 * 这个坑本项目踩到第三次（前两次：Jellyfin 填 `localhost`、WebSocket 地址
 * 写死 `localhost`），因此集中到一处并把判定写死。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { browserHost, browserOrigin, hostnameOf } from "@/lib/auth/request-origin";

const h = (host: string | null, forwardedHost: string | null = null, proto: string | null = null) => ({
  host,
  forwardedHost,
  forwardedProto: proto,
});

test("优先用 Host 头 —— 那才是浏览器访问的地址", () => {
  assert.equal(browserHost(h("192.168.6.203:3100")), "192.168.6.203:3100");
  assert.equal(browserOrigin(h("192.168.6.203:3100")), "http://192.168.6.203:3100");
});

test("有反代时优先用 x-forwarded-host", () => {
  assert.equal(browserHost(h("web:3100", "hit-ani.example.edu")), "hit-ani.example.edu");
  assert.equal(
    browserOrigin(h("web:3100", "hit-ani.example.edu", "https")),
    "https://hit-ani.example.edu",
  );
});

test("多跳 x-forwarded-host 取**第一跳**（最靠近客户端的那个）", () => {
  // 代理链会把每一跳依次追加：`client, proxy1, proxy2`
  assert.equal(browserHost(h("web:3100", "192.168.6.203:3100, 10.0.0.1")), "192.168.6.203:3100");
  assert.equal(browserHost(h("web:3100", "  hit.test  ,  10.0.0.1")), "hit.test");
});

test("x-forwarded-proto 决定协议，默认 http", () => {
  // 本项目主力部署是明文 HTTP；反代终止 TLS 时真实协议在 x-forwarded-proto
  assert.equal(browserOrigin(h("app:3100")), "http://app:3100");
  assert.equal(browserOrigin(h("app:3100", null, "https")), "https://app:3100");
  assert.equal(browserOrigin(h("app:3100", null, "https, http")), "https://app:3100");
  // 无法识别的协议退回 http，而不是拼出一个奇怪的 scheme
  assert.equal(browserOrigin(h("app:3100", null, "gopher")), "http://app:3100");
});

test("缺少 Host 头时返回 null —— 调用方退回原行为，而不是崩掉", () => {
  assert.equal(browserHost(h(null)), null);
  assert.equal(browserOrigin(h(null)), null);
});

test("形状可疑的 host 被丢弃（可能是构造的恶意头）", () => {
  // 这些都不可能是合法的 host 头值；放行会让重定向指向任意位置
  for (const bad of ["evil.com/path", "a b", "a\\b", "user@evil.com", ""]) {
    assert.equal(browserHost(h(bad)), null, `${JSON.stringify(bad)} 不该被当 host`);
  }
  // 前者非法时退回后者
  assert.equal(browserHost(h("good.test:3100", "evil.com/x")), "good.test:3100");
});

test("大小写归一化", () => {
  assert.equal(browserHost(h("Example.TEST:3100")), "example.test:3100");
});

test("hostnameOf 去掉端口，并按 RFC 6265 处理 Cookie 作用域", () => {
  // Cookie 只看主机名 —— 实测确认跨端口共享
  assert.equal(hostnameOf("localhost:3100"), "localhost");
  assert.equal(hostnameOf("192.168.6.203:3100"), "192.168.6.203");
  assert.equal(hostnameOf("[::1]:3100"), "[::1]");
});

test("hostnameOf 对畸形输入返回 null —— 不依赖调用方先过滤", () => {
  // `new URL("http://a/b")` 会"成功"解析出 hostname `a`（斜杠被当成路径），
  // 因此必须自己先做形状校验，否则明显非法的输入会被当成合法主机名。
  for (const bad of ["a/b", "a b", "a\\b", "user@host", ""]) {
    assert.equal(hostnameOf(bad), null, `${JSON.stringify(bad)} 应返回 null`);
  }
});
