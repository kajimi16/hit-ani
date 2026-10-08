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
import {
  announceEgress,
  egressShape,
  probeProxyReachable,
  resetEgressAnnouncement,
} from "@/lib/net/egress";

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

/* ================================================================== *
 * 启动时的输出 —— 必须「真探一次」再决定喊不喊
 * ================================================================== */

/**
 * 打**真实的** `announceEgress` 并收集它打印的内容。
 *
 * 刻意不在测试里重抄一遍分支判断 —— 那样测的是「测试里的复制品」，
 * 生产代码里的分支写错了也不会失败（正是本项目踩过的假阴性）。
 */
async function capture(
  env: Record<string, string | undefined>,
  reachable: boolean,
): Promise<string[]> {
  const saved = process.env["HTTP_PROXY"];
  if (env["HTTP_PROXY"] === undefined) delete process.env["HTTP_PROXY"];
  else process.env["HTTP_PROXY"] = env["HTTP_PROXY"];

  resetEgressAnnouncement();
  const lines: string[] = [];
  try {
    await announceEgress(async () => reachable, (m) => lines.push(m));
  } finally {
    if (saved === undefined) delete process.env["HTTP_PROXY"];
    else process.env["HTTP_PROXY"] = saved;
  }
  return lines;
}

test("★ 代理可达时只打一行 —— 否则每次启动都误报，训练人忽略它", async () => {
  const lines = await capture({ HTTP_PROXY: "http://host.docker.internal:7897" }, true);
  assert.equal(lines.length, 1, `应只打一行，实际: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /可达/);
  assert.ok(!lines[0].includes("⚠️"), "可达时不该有警告标记");
});

test("★ 代理探不通时必须喊出警告（这才是服务器上真实发生的情况）", async () => {
  const lines = await capture({ HTTP_PROXY: "http://host.docker.internal:7897" }, false);
  assert.ok(lines.length > 1, "警告应当是多行的一段");
  assert.ok(
    lines.some((l) => l.includes("⚠️")),
    `应有警告标记，实际: ${JSON.stringify(lines)}`,
  );
  // 警告要给出处置办法，而不只是「出问题了」
  assert.ok(lines.some((l) => l.includes("HTTP_PROXY_URL")), "应给出该改哪个变量");
});

test("★ 探不通的**显式**代理也要喊，且处置建议不同", async () => {
  const lines = await capture({ HTTP_PROXY: "http://10.0.0.9:3128" }, false);
  assert.ok(
    lines.some((l) => l.includes("⚠️")),
    "配了代理却连不上，无论指向哪里都该喊",
  );
  // 显式配置的代理不该被告知「去删掉变量」——那是误配的处置办法
  assert.ok(
    !lines.some((l) => l.includes("留空")),
    "显式代理的处置建议不该是「把变量留空」",
  );
  assert.ok(lines.some((l) => l.includes("确认代理真的在运行")), "应给出针对显式代理的建议");
});

test("显式代理可达时也只打一行", async () => {
  const lines = await capture({ HTTP_PROXY: "http://10.0.0.9:3128" }, true);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.match(lines[0], /可达/);
});

test("直连形态不探测、不报警（校内服务器应走这条）", async () => {
  const lines = await capture({}, false);
  assert.deepEqual(lines, ["[egress] 出站直连（未配置代理）"]);
});

test("探测必须有界 —— 不可达时在超时内返回 false，不挂住启动", async () => {
  // 10.255.255.1 是保留地址，一定连不上
  const started = Date.now();
  const ok = await probeProxyReachable("http://10.255.255.1:9", 300);
  const elapsed = Date.now() - started;
  assert.equal(ok, false);
  assert.ok(elapsed < 3000, `探测耗时 ${elapsed}ms，必须远小于启动可接受时间`);
});

test("探测到本机真实监听的端口返回 true（正向也要能测出来）", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await probeProxyReachable(`http://127.0.0.1:${port}`), true);
  } finally {
    server.close();
  }
});

test("非法地址返回 false 而不是抛异常（启动钩子里抛出会让进程起不来）", async () => {
  assert.equal(await probeProxyReachable("不是个 URL"), false);
  assert.equal(await probeProxyReachable(""), false);
});
