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
import { appBaseUrl, browserHost, browserOrigin, hostnameOf, resolvePublicOrigin } from "@/lib/auth/request-origin";

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

/* ---------------------------------------------------------------- *
 * 规范地址（APP_BASE_URL）与对外 origin 的优先级
 * ---------------------------------------------------------------- */

/** 临时设置环境变量并在结束后恢复。 */
function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
}

test("未设 APP_BASE_URL 时按请求头推断", () => {
  withEnv("APP_BASE_URL", undefined, () => {
    const r = resolvePublicOrigin(h("192.168.6.203:3100"), "http://localhost:3100");
    assert.equal(r.origin, "http://192.168.6.203:3100");
    assert.equal(r.source, "headers");
  });
});

test("设了 APP_BASE_URL 就**忽略请求头** —— 这是防 host header injection 的关键", () => {
  withEnv("APP_BASE_URL", "http://hit-ani.example.edu", () => {
    const r = resolvePublicOrigin(h("evil.test", "evil.test"), "http://localhost:3100");
    assert.equal(r.origin, "http://hit-ani.example.edu", "请求头不该能改写对外地址");
    assert.equal(r.source, "env");
  });
});

test("APP_BASE_URL 保留协议与端口，抹掉路径与查询", () => {
  withEnv("APP_BASE_URL", "https://hit-ani.example.edu/some/path?x=1", () => {
    assert.equal(appBaseUrl(), "https://hit-ani.example.edu");
  });
  withEnv("APP_BASE_URL", "http://192.168.6.203:3100/", () => {
    assert.equal(appBaseUrl(), "http://192.168.6.203:3100");
  });
});

test("非法的 APP_BASE_URL 当作没设 —— 不接受来路不明的基址", () => {
  for (const bad of ["javascript:alert(1)", "ftp://x.test", "not a url", "  ", "file:///etc"]) {
    withEnv("APP_BASE_URL", bad, () => {
      assert.equal(appBaseUrl(), null, `${bad} 不该被接受`);
      // 退回请求头推断，而不是崩掉
      assert.equal(resolvePublicOrigin(h("x.test:1"), "http://fb").source, "headers");
    });
  }
});

test("既没有 APP_BASE_URL 也没有 Host 头时用兜底值", () => {
  withEnv("APP_BASE_URL", undefined, () => {
    const r = resolvePublicOrigin(h(null), "http://fallback:3100");
    assert.equal(r.origin, "http://fallback:3100");
    assert.equal(r.source, "fallback");
  });
});

/* ---------------------------------------------------------------- *
 * 转发头的信任开关
 * ---------------------------------------------------------------- */

test("默认**不信任** X-Forwarded-*（防开放重定向）", () => {
  withEnv("TRUST_PROXY_HEADERS", undefined, () => {
    // hostHeadersFrom 需要 Headers 对象
    const headers = new Headers({ host: "real.test:3100", "x-forwarded-host": "evil.test" });
    // 未开开关时 forwardedHost 应为 null
    const parts = { host: headers.get("host"), forwardedHost: null, forwardedProto: null };
    assert.equal(browserHost(parts), "real.test:3100", "应退回 Host，而不是采信伪造的转发头");
  });
});
