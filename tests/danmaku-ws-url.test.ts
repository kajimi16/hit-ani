/**
 * 弹幕网关地址规范化测试。
 *
 * ## 防的是什么
 *
 * `NEXT_PUBLIC_DANMAKU_WS_URL` 的文档写着「适合反向代理场景」，但旧实现把
 * 配置值**原样**拼上路径：
 *
 * - 填 `/danmaku-ws`（同源路径，反向代理最常见的配法）→
 *   `new URL("/danmaku-ws/danmaku/room/1")` 抛 `Invalid URL`；
 * - 填 `https://domain/ws`（很自然的写法）→ `new WebSocket("https://…")`
 *   抛 `SyntaxError`，因为只接受 `ws:` / `wss:`。
 *
 * 两种都是「按文档配了反而整个弹幕挂掉」，而且报错信息与配置无关。
 * 域名 + 反向代理是**必然**要走到的路径，所以这里把三种形态都锁住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeWsBase } from "@/lib/danmaku/ws-url";

const HTTP = { protocol: "http:", host: "10.0.0.5:3100" };
const HTTPS = { protocol: "https:", host: "anime.example.edu" };

test("★ 同源路径跟随页面的协议与端口 —— 反向代理后面就是 443 + 那张证书", () => {
  assert.equal(
    normalizeWsBase("/danmaku-ws", HTTPS),
    "wss://anime.example.edu/danmaku-ws",
  );
  // http 页面不能给 wss，否则浏览器会因协议不匹配而拒绝
  assert.equal(normalizeWsBase("/danmaku-ws", HTTP), "ws://10.0.0.5:3100/danmaku-ws");
});

test("★ https:// 会转成 wss:// —— 直接用会让 new WebSocket 抛 SyntaxError", () => {
  assert.equal(
    normalizeWsBase("https://anime.example.edu/ws", HTTPS),
    "wss://anime.example.edu/ws",
  );
  assert.equal(normalizeWsBase("http://10.0.0.5:3102", HTTP), "ws://10.0.0.5:3102");
});

test("已经写成 ws/wss 的原样保留（不重复转换）", () => {
  assert.equal(normalizeWsBase("wss://anime.example.edu/ws", HTTPS), "wss://anime.example.edu/ws");
  assert.equal(normalizeWsBase("ws://10.0.0.5:3102", HTTP), "ws://10.0.0.5:3102");
});

test("尾斜杠被去掉 —— 否则拼出 `//danmaku/room/1`，网关的正则匹配不上", () => {
  assert.equal(normalizeWsBase("/danmaku-ws/", HTTPS), "wss://anime.example.edu/danmaku-ws");
  assert.equal(normalizeWsBase("wss://h/ws///", HTTPS), "wss://h/ws");
});

test("裸主机名按页面协议补 scheme（例如只写了 `gateway:3102`）", () => {
  assert.equal(normalizeWsBase("gateway:3102", HTTP), "ws://gateway:3102");
  assert.equal(normalizeWsBase("gateway:3102", HTTPS), "wss://gateway:3102");
});

test("大小写不敏感（`WSS://` / `HTTPS://` 都算）", () => {
  assert.equal(normalizeWsBase("WSS://h/ws", HTTPS), "WSS://h/ws");
  assert.equal(normalizeWsBase("HTTPS://h/ws", HTTPS), "wss://h/ws");
});

test("前后空白被忽略（`.env` 里很容易多一个空格）", () => {
  assert.equal(normalizeWsBase("  /ws  ", HTTPS), "wss://anime.example.edu/ws");
});

test("空值抛出 —— 调用方会退回「按页面地址推导」", () => {
  // 这条锁的是「不能返回空串」：空串拼出来的 URL 是相对路径，
  // 下一步 `new URL` 又会抛，等于把问题推得更远。
  assert.throws(() => normalizeWsBase("", HTTPS));
  assert.throws(() => normalizeWsBase("   ", HTTPS));
});

test("结果一定能被 new URL 解析（这是下游 `new WebSocket` 的前提）", () => {
  for (const value of ["/danmaku-ws", "https://h/ws", "wss://h/ws", "gateway:3102", "  /ws  "]) {
    const base = normalizeWsBase(value, HTTPS);
    const room = `${base}/danmaku/room/1`;
    assert.doesNotThrow(() => new URL(room), `${value} → ${room} 解析失败`);
    assert.match(room, /^wss?:\/\//, `${value} → ${room} 不是 ws 协议`);
  }
});
