/**
 * 出站代理形态检查测试。
 *
 * ## 防的是什么
 *
 * `.env` 要**整份复制到服务器**（里面有 `SESSION_SECRET`、SMTP 凭据），
 * 于是本机为了 Clash 写下的 `HTTP_PROXY_URL=http://host.docker.internal:7897`
 * 会跟着过去。服务器上没有那个代理 → BGM / 弹幕源 / 媒体源**全部**
 * `fetch failed`，探索页显示「Bangumi 搜索失败」——
 * **与代码有 bug 的症状完全一样**。
 *
 * 因此这里锁的是「能不能把这种情况认出来」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { egressShape } from "@/lib/net/egress";

test("未设置或为空 → 直连（校内服务器应当是这个形态）", () => {
  assert.deepEqual(egressShape({}), { kind: "direct" });
  // compose 用 `${VAR-}` 展开，未设置时产出**空字符串**而不是缺失 ——
  // 这正是「默认直连」得以生效的原因，必须认这种形态。
  assert.deepEqual(egressShape({ HTTP_PROXY: "" }), { kind: "direct" });
  // 只有空白也算未设置（`??` 对空字符串无效，这里必须 trim）
  assert.deepEqual(egressShape({ HTTP_PROXY: "   " }), { kind: "direct" });
});

test("★ host.docker.internal 被识别为「开发机代理」—— 这是 .env 被复制的指纹", () => {
  const shape = egressShape({ HTTP_PROXY: "http://host.docker.internal:7897" });
  assert.equal(shape.kind, "dev-proxy");
});

test("127.0.0.1 / localhost 也算开发机代理（容器里的 127.0.0.1 是它自己）", () => {
  assert.equal(egressShape({ HTTP_PROXY: "http://127.0.0.1:7897" }).kind, "dev-proxy");
  assert.equal(egressShape({ HTTP_PROXY: "http://localhost:7897" }).kind, "dev-proxy");
});

test("真实的远端代理被认作 proxy（不是误报）", () => {
  const shape = egressShape({ HTTP_PROXY: "http://10.0.0.9:3128" });
  assert.deepEqual(shape, { kind: "proxy", url: "http://10.0.0.9:3128" });
});

test("大小写不敏感 —— 代理地址可能被写成 Host.Docker.Internal", () => {
  assert.equal(egressShape({ HTTP_PROXY: "http://HOST.DOCKER.INTERNAL:7897" }).kind, "dev-proxy");
});

test("形态判定不抛异常（启动钩子里抛出会让整个进程起不来）", () => {
  assert.doesNotThrow(() => egressShape({ HTTP_PROXY: "不是个 URL" }));
  // 非法值不算「开发机代理」，按普通代理呈现
  assert.equal(egressShape({ HTTP_PROXY: "不是个 URL" }).kind, "proxy");
});
