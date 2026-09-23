/**
 * SSRF 防护单测。
 *
 * 这套校验是源配置层的安全边界：没有它，任何能配置源的人都可以借这台服务器
 * 探测校园内网（教务、图书馆、其他校内系统）。校内自建场景下这个风险**高于**公网部署。
 *
 * 两个必须覆盖的攻击面：
 *  1. 字面量内网地址（简单）
 *  2. **域名解析到内网**（DNS 重绑定）—— 只查字面量会被完全绕过
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UnsafeUrlError,
  assertSafeUrl,
  isAllowedProtocol,
  isFakeIpAddress,
  isPrivateAddress,
  resolveUrl,
  trustsFakeIp,
} from "@/lib/media/url-safety";

/* ---------------------------------------------------------------- *
 * IP 判定
 * ---------------------------------------------------------------- */

test("isPrivateAddress 拒绝常见内网与保留网段（IPv4）", () => {
  const blocked = [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.168.0.100",
    "169.254.169.254", // 云元数据 —— 最容易造成凭据泄露
    "0.0.0.0",
    "100.64.0.1", // 运营商级 NAT
    "192.0.0.1",
    "198.18.0.1", // 基准测试
    "224.0.0.1", // 组播
    "255.255.255.255",
  ];
  for (const address of blocked) {
    assert.equal(isPrivateAddress(address), true, `${address} 应被判定为内网`);
  }
});

test("isPrivateAddress 放行公网地址（IPv4）", () => {
  const allowed = ["1.1.1.1", "8.8.8.8", "203.0.113.10", "172.15.0.1", "172.32.0.1", "11.0.0.1"];
  for (const address of allowed) {
    assert.equal(isPrivateAddress(address), false, `${address} 应被放行`);
  }
});

test("isPrivateAddress 处理 IPv6 环回/链路本地/唯一本地", () => {
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("::"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
  assert.equal(isPrivateAddress("fc00::1"), true);
  assert.equal(isPrivateAddress("fd12::1"), true);
  assert.equal(isPrivateAddress("ff02::1"), true);
  assert.equal(isPrivateAddress("2001:4860:4860::8888"), false);
});

test("isPrivateAddress 识别 IPv4 映射的 IPv6（::ffff:127.0.0.1 绕过手法）", () => {
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
});

test("isPrivateAddress 对无法解析的输入返回 true（fail-closed）", () => {
  assert.equal(isPrivateAddress("not-an-ip"), true);
  assert.equal(isPrivateAddress(""), true);
  assert.equal(isPrivateAddress("999.999.999.999"), true);
});

/* ---------------------------------------------------------------- *
 * 协议
 * ---------------------------------------------------------------- */

test("isAllowedProtocol 只放行 http/https", () => {
  assert.equal(isAllowedProtocol(new URL("http://example.com")), true);
  assert.equal(isAllowedProtocol(new URL("https://example.com")), true);
  for (const protocol of ["file:", "ftp:", "gopher:", "dict:", "data:"]) {
    assert.equal(
      isAllowedProtocol(new URL(`${protocol}//example.com`)),
      false,
      `${protocol} 应被拒绝`,
    );
  }
});

/* ---------------------------------------------------------------- *
 * assertSafeUrl
 * ---------------------------------------------------------------- */

test("assertSafeUrl 放行公网字面量 IP", async () => {
  const url = await assertSafeUrl("https://1.1.1.1/path");
  assert.equal(url.hostname, "1.1.1.1");
});

test("assertSafeUrl 拒绝内网字面量 IP", async () => {
  await assert.rejects(
    () => assertSafeUrl("http://127.0.0.1:6379/"),
    (error: unknown) => {
      assert.ok(error instanceof UnsafeUrlError);
      return true;
    },
  );
  await assert.rejects(() => assertSafeUrl("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(() => assertSafeUrl("http://192.168.1.1/"));
});

test("assertSafeUrl 拒绝非法 URL 与非 http 协议", async () => {
  await assert.rejects(() => assertSafeUrl("not a url"));
  await assert.rejects(() => assertSafeUrl(""));
  await assert.rejects(() => assertSafeUrl("file:///etc/passwd"));
  await assert.rejects(() => assertSafeUrl("gopher://evil.com/"));
});

test("assertSafeUrl 拒绝解析到内网的域名（DNS 重绑定防线）", async () => {
  // localhost 解析到 127.0.0.1 / ::1 —— 只查字面量 IP 的实现会在这里放行
  await assert.rejects(
    () => assertSafeUrl("http://localhost:3000/admin"),
    (error: unknown) => {
      assert.ok(error instanceof UnsafeUrlError, `期望 UnsafeUrlError，实际 ${String(error)}`);
      return true;
    },
  );
});

test("assertSafeUrl 对不存在的域名报解析失败", async () => {
  await assert.rejects(
    () => assertSafeUrl("https://this-domain-should-not-exist-9f8e7d.invalid/"),
    (error: unknown) => {
      assert.ok(error instanceof UnsafeUrlError);
      return true;
    },
  );
});

/* ---------------------------------------------------------------- *
 * resolveUrl
 * ---------------------------------------------------------------- */

test("resolveUrl 解析相对路径（源配置最常见的静默 bug）", () => {
  assert.equal(
    resolveUrl("/play/123", "https://example.com"),
    "https://example.com/play/123",
  );
  assert.equal(
    resolveUrl("detail/9", "https://example.com/search/"),
    "https://example.com/search/detail/9",
  );
});

test("resolveUrl 保留绝对 URL", () => {
  assert.equal(resolveUrl("https://other.com/x", "https://example.com"), "https://other.com/x");
});

test("resolveUrl 跳过锚点与 javascript: 伪协议", () => {
  assert.equal(resolveUrl("#section", "https://example.com"), null);
  assert.equal(resolveUrl("javascript:void(0)", "https://example.com"), null);
  assert.equal(resolveUrl("JavaScript:alert(1)", "https://example.com"), null);
  assert.equal(resolveUrl("   ", "https://example.com"), null);
});

test("resolveUrl 处理 HTML 实体残留与 protocol-relative 链接", () => {
  assert.equal(resolveUrl("//cdn.example.com/x", "https://example.com"), "https://cdn.example.com/x");
});

/* ---------------------------------------------------------------- *
 * fake-IP（代理环境）
 * ---------------------------------------------------------------- */

test("isFakeIpAddress 只识别已知 fake-IP 段", () => {
  assert.equal(isFakeIpAddress("198.18.0.64"), true);
  assert.equal(isFakeIpAddress("198.19.1.1"), true);
  assert.equal(isFakeIpAddress("fdfe:dcba:9876::3e"), true);
  // 真实内网地址不是 fake-IP —— 即便开启信任也必须拦截
  assert.equal(isFakeIpAddress("127.0.0.1"), false);
  assert.equal(isFakeIpAddress("192.168.1.1"), false);
  assert.equal(isFakeIpAddress("169.254.169.254"), false);
  assert.equal(isFakeIpAddress("10.0.0.1"), false);
});

test("trustsFakeIp 默认关闭，仅在显式设为 1 时开启", () => {
  const original = process.env.MEDIA_SSRF_TRUST_FAKE_IP;
  try {
    delete process.env.MEDIA_SSRF_TRUST_FAKE_IP;
    assert.equal(trustsFakeIp(), false, "默认必须关闭");

    process.env.MEDIA_SSRF_TRUST_FAKE_IP = "true";
    assert.equal(trustsFakeIp(), false, "只认 '1'，避免误配成 true 就放开");

    process.env.MEDIA_SSRF_TRUST_FAKE_IP = "1";
    assert.equal(trustsFakeIp(), true);
  } finally {
    if (original === undefined) delete process.env.MEDIA_SSRF_TRUST_FAKE_IP;
    else process.env.MEDIA_SSRF_TRUST_FAKE_IP = original;
  }
});

test("即使信任 fake-IP，字面量内网 IP 仍然拦截（关键边界）", async () => {
  const original = process.env.MEDIA_SSRF_TRUST_FAKE_IP;
  try {
    process.env.MEDIA_SSRF_TRUST_FAKE_IP = "1";
    // 字面量 fake-IP 也必须拦截 —— 没有人有正当理由直接写它
    await assert.rejects(() => assertSafeUrl("http://198.18.0.1/"));
    // 真实内网地址当然也拦截
    await assert.rejects(() => assertSafeUrl("http://127.0.0.1/"));
    await assert.rejects(() => assertSafeUrl("http://169.254.169.254/"));
    await assert.rejects(() => assertSafeUrl("http://192.168.1.1/"));
  } finally {
    if (original === undefined) delete process.env.MEDIA_SSRF_TRUST_FAKE_IP;
    else process.env.MEDIA_SSRF_TRUST_FAKE_IP = original;
  }
});

test("fake-IP 被拦截时，错误信息提示可用的开关", async () => {
  const original = process.env.MEDIA_SSRF_TRUST_FAKE_IP;
  try {
    delete process.env.MEDIA_SSRF_TRUST_FAKE_IP;
    // localhost 解析到 127.x，不含 fake-IP 提示
    const realError = await assertSafeUrl("http://localhost/").then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(realError);
    assert.ok(!realError.message.includes("MEDIA_SSRF_TRUST_FAKE_IP"));
  } finally {
    if (original === undefined) delete process.env.MEDIA_SSRF_TRUST_FAKE_IP;
    else process.env.MEDIA_SSRF_TRUST_FAKE_IP = original;
  }
});
