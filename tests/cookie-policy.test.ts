/**
 * Cookie `Secure` 标志判定测试。
 *
 * ## 背景：真实事故
 *
 * 原先写 `secure: process.env.NODE_ENV === "production"` —— 容器里它是
 * production，于是会话 Cookie 带 `Secure`。而浏览器**拒绝在明文 HTTP 的
 * 非 localhost 源上存储 Secure Cookie**，导致从局域网 IP 访问时：
 *
 *     登录 POST → 200
 *     响应头    → Set-Cookie: ...; Secure
 *     浏览器    → 静默丢弃
 *     后续请求  → 仍是未登录
 *
 * **这个 bug 躲过了全部自动化验证**，因为所有测试都走 `localhost` ——
 * 而 localhost 被浏览器当作可信源豁免 Secure 要求。实测对照：
 *
 *     http://192.168.6.203:3100  → cookie 未落盘，服务端看到 null
 *     http://localhost:3100      → cookie 落盘，服务端看到用户
 *
 * 与 Jellyfin 填 `localhost`、WS 地址写死 `localhost` 是同一类
 * 「环境假设」缺陷。这组测试锁死判定逻辑。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  secureCookieOverride,
  shouldUseSecureCookie,
} from "@/lib/auth/cookie-policy";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.SESSION_COOKIE_SECURE;
  try {
    if (value === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = value;
    return fn();
  } finally {
    if (original === undefined) delete process.env.SESSION_COOKIE_SECURE;
    else process.env.SESSION_COOKIE_SECURE = original;
  }
}

/* ---------------------------------------------------------------- *
 * 核心：按真实协议判定，不依赖 NODE_ENV
 * ---------------------------------------------------------------- */

test("直连 HTTP（无反代头）不加 Secure —— 这是事故的修复点", () => {
  withEnv(undefined, () => {
    // 局域网 IP 直连时没有 x-forwarded-proto
    assert.equal(shouldUseSecureCookie({ forwardedProto: null }), false);
    assert.equal(shouldUseSecureCookie({ forwardedProto: undefined }), false);
    assert.equal(
      shouldUseSecureCookie({ forwardedProto: "" }),
      false,
      "空串应视为无信号",
    );
  });
});

test("反代置 x-forwarded-proto=https 时加 Secure", () => {
  withEnv(undefined, () => {
    assert.equal(shouldUseSecureCookie({ forwardedProto: "https" }), true);
    assert.equal(shouldUseSecureCookie({ forwardedProto: "HTTPS" }), true, "大小写不敏感");
    assert.equal(shouldUseSecureCookie({ forwardedProto: " https " }), true, "应去空白");
  });
});

test("反代置 http 时不加 Secure", () => {
  withEnv(undefined, () => {
    assert.equal(shouldUseSecureCookie({ forwardedProto: "http" }), false);
  });
});

test("多跳代理链取第一跳", () => {
  withEnv(undefined, () => {
    assert.equal(shouldUseSecureCookie({ forwardedProto: "https, http" }), true);
    assert.equal(shouldUseSecureCookie({ forwardedProto: "http, https" }), false);
  });
});

test("与 NODE_ENV 无关（关键回归）", () => {
  const env = process.env as Record<string, string | undefined>;
  const original = env.NODE_ENV;
  try {
    // 即使容器里是 production，直连 HTTP 也不该加 Secure
    env.NODE_ENV = "production";
    assert.equal(
      shouldUseSecureCookie({ forwardedProto: null }),
      false,
      "不能再让 NODE_ENV 决定 Secure —— 那正是登录失效的成因",
    );
  } finally {
    env.NODE_ENV = original;
  }
});

/* ---------------------------------------------------------------- *
 * 显式覆盖
 * ---------------------------------------------------------------- */

test("override=1 强制加 Secure（即使协议是 http）", () => {
  assert.equal(shouldUseSecureCookie({ forwardedProto: "http", override: true }), true);
  assert.equal(shouldUseSecureCookie({ forwardedProto: null, override: true }), true);
});

test("override=0 强制不加 Secure（即使协议是 https）", () => {
  assert.equal(shouldUseSecureCookie({ forwardedProto: "https", override: false }), false);
});

test("secureCookieOverride 只认 '1' 与 '0'", () => {
  assert.equal(secureCookieOverride("1"), true);
  assert.equal(secureCookieOverride("0"), false);
  // 避免 `false`/`no` 这类误配造成意外行为
  for (const other of ["true", "false", "yes", "no", "", undefined]) {
    assert.equal(secureCookieOverride(other), null, `"${other}" 应视为未指定`);
  }
});

test("环境变量覆盖优先于协议判定", () => {
  withEnv("0", () => {
    assert.equal(
      shouldUseSecureCookie({ forwardedProto: "https" }),
      false,
      "显式关闭应盖过 https",
    );
  });
  withEnv("1", () => {
    assert.equal(shouldUseSecureCookie({ forwardedProto: "http" }), true);
  });
});

/* ---------------------------------------------------------------- *
 * 与事故现场对应的场景表
 * ---------------------------------------------------------------- */

test("三种部署形态都得到正确结果", () => {
  withEnv(undefined, () => {
    const cases = [
      { name: "本机开发（localhost，直连 http）", proto: null, expect: false },
      { name: "局域网 IP 直连 http（本次事故现场）", proto: null, expect: false },
      { name: "反代 TLS（Caddy/Nginx）", proto: "https", expect: true },
    ];
    for (const c of cases) {
      assert.equal(
        shouldUseSecureCookie({ forwardedProto: c.proto }),
        c.expect,
        `${c.name} 判定错误`,
      );
    }
  });
});
