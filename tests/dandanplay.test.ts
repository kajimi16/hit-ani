/**
 * dandanplay 客户端单测：签名算法与弹幕字段解析。
 *
 * 这两块是最容易写错、也最难在集成测试里发现的部分：
 * - 签名用错 path（带上 query 或 host）会让**所有请求** 403，但本地无法察觉；
 * - `p` 字段解析错了会静默丢弹幕或位置全错，看渲染结果根本看不出来。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  authHeaders,
  authMode,
  DandanplayError,
  generateSignature,
  parseComments,
  parseDandanplayComment,
  DANDANPLAY_REQUEST_INTERVAL_MS,
} from "@/lib/danmaku/dandanplay";
import { DanmakuLocation } from "@/lib/danmaku/types";

test("签名 = Base64(SHA256(appId + ts + path + secret))", () => {
  const appId = "testAppId";
  const appSecret = "testSecret";
  const timestamp = 1_700_000_000;
  const path = "/api/v2/comment/123";

  const expected = createHash("sha256")
    .update(`${appId}${timestamp}${path}${appSecret}`, "utf8")
    .digest("base64");

  assert.equal(generateSignature(appId, timestamp, path, appSecret), expected);
});

test("签名只依赖 path，不含 host 与 query", () => {
  const a = generateSignature("id", 1000, "/api/v2/comment/123", "secret");
  // 若实现误把 query 或 host 拼进去，这两个值就会不同
  const b = generateSignature("id", 1000, "/api/v2/comment/123", "secret");
  assert.equal(a, b);

  const withQuery = generateSignature("id", 1000, "/api/v2/comment/123?chConvert=0", "secret");
  assert.notEqual(withQuery, a, "带 query 的 path 必须产生不同签名（说明实现确实只用 path）");
});

test("签名对 secret 敏感（不同 secret 不同结果）", () => {
  const a = generateSignature("id", 1000, "/x", "secret-a");
  const b = generateSignature("id", 1000, "/x", "secret-b");
  assert.notEqual(a, b);
});

test("authHeaders 签名模式生成三个头，时间戳为秒", () => {
  const headers = authHeaders(
    { appId: "myId", appSecret: "mySecret" },
    "/api/v2/comment/1",
    1_700_000_000_000, // 毫秒
    "signature",
  );
  assert.equal(headers["X-AppId"], "myId");
  assert.equal(headers["X-Timestamp"], "1700000000");
  assert.equal(
    headers["X-Signature"],
    generateSignature("myId", 1_700_000_000, "/api/v2/comment/1", "mySecret"),
  );
});

test("解析 p 字段：时间秒 → 毫秒", () => {
  const dto = parseDandanplayComment(
    { cid: 42, p: "12.34,1,16777215,user1", m: "233" },
    8,
  );
  assert.ok(dto);
  assert.equal(dto.playTimeMs, 12340);
  assert.equal(dto.color, 0xffffff);
  assert.equal(dto.text, "233");
  assert.equal(dto.location, DanmakuLocation.Normal);
  assert.equal(dto.id, "ddp-42");
  assert.equal(dto.episodeId, 8);
});

test("模式映射：1=滚动 4=底部 5=顶部", () => {
  const mode = (m: string) =>
    parseDandanplayComment({ cid: 1, p: `1.0,${m},16777215,u`, m: "x" }, 1)?.location;

  assert.equal(mode("1"), DanmakuLocation.Normal);
  assert.equal(mode("4"), DanmakuLocation.Bottom);
  assert.equal(mode("5"), DanmakuLocation.Top);
});

test("不支持的模式被丢弃（返回 null）而非猜测", () => {
  for (const m of ["2", "3", "6", "7", "8", "9", "0"]) {
    assert.equal(
      parseDandanplayComment({ cid: 1, p: `1.0,${m},16777215,u`, m: "x" }, 1),
      null,
      `模式 ${m} 应被丢弃`,
    );
  }
});

test("畸形 p 字段被丢弃", () => {
  const bad = [
    "",                       // 空
    "1.0",                    // 段数不足
    "1.0,1,16777215",         // 三段
    "abc,1,16777215,u",       // 时间非数字
    "-5,1,16777215,u",        // 负时间
    "1.0,1,abc,u",            // 颜色非数字
    "1.0,1,-1,u",             // 负颜色
    "1.0,1,99999999,u",       // 颜色超 0xFFFFFF
  ];
  for (const p of bad) {
    assert.equal(
      parseDandanplayComment({ cid: 1, p, m: "x" }, 1),
      null,
      `p="${p}" 应被丢弃`,
    );
  }
});

test("空文本被丢弃", () => {
  assert.equal(parseDandanplayComment({ cid: 1, p: "1.0,1,16777215,u", m: "" }, 1), null);
});

test("弹幕的 schoolId 为空串 —— 天然排除在「只看本校」之外", () => {
  const dto = parseDandanplayComment({ cid: 1, p: "1.0,1,16777215,u", m: "x" }, 1);
  assert.equal(dto?.schoolId, "");
  assert.equal(dto?.serviceId, "Dandanplay");
});

test("parseComments 过滤坏数据并保留好数据", () => {
  const list = parseComments(
    {
      count: 4,
      comments: [
        { cid: 1, p: "1.00,1,16777215,u1", m: "好的" },
        { cid: 2, p: "bad", m: "坏的" },
        { cid: 3, p: "2.50,5,16711680,u2", m: "顶部红字" },
        { cid: 4, p: "3.00,9,16777215,u3", m: "不支持的模式" },
      ],
    },
    8,
  );
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((d) => d.text),
    ["好的", "顶部红字"],
  );
  assert.equal(list[1].location, DanmakuLocation.Top);
  assert.equal(list[1].color, 0xff0000);
});

test("请求间隔常量为正（避免限流）", () => {
  assert.ok(DANDANPLAY_REQUEST_INTERVAL_MS > 0);
});

/* ---------------------------------------------------------------- *
 * 鉴权模式与错误信息透出
 * ---------------------------------------------------------------- */

test("默认使用凭证模式（服务器端推荐，少一类时间戳故障）", async () => {
  const original = process.env.DANDANPLAY_AUTH_MODE;
  try {
    delete process.env.DANDANPLAY_AUTH_MODE;
    assert.equal(authMode(), "credential");

    process.env.DANDANPLAY_AUTH_MODE = "signature";
    assert.equal(authMode(), "signature");

    // 非法值回退默认，而不是抛错
    process.env.DANDANPLAY_AUTH_MODE = "nonsense";
    assert.equal(authMode(), "credential");
  } finally {
    if (original === undefined) delete process.env.DANDANPLAY_AUTH_MODE;
    else process.env.DANDANPLAY_AUTH_MODE = original;
  }
});

test("凭证模式的头部只含 AppId 与 AppSecret", () => {
  const headers: Record<string, string> = authHeaders(
    { appId: "id", appSecret: "secret" },
    "/api/v2/comment/1",
    1_700_000_000_000,
    "credential",
  );
  // 用 key 集合断言，避免 assert.deepEqual 的断言签名把类型收窄
  assert.deepEqual(Object.keys(headers).sort(), ["X-AppId", "X-AppSecret"]);
  assert.equal(headers["X-AppId"], "id");
  assert.equal(headers["X-AppSecret"], "secret");
});

test("签名模式的头部含时间戳与签名", () => {
  const headers: Record<string, string> = authHeaders(
    { appId: "id", appSecret: "secret" },
    "/api/v2/comment/1",
    1_700_000_000_000,
    "signature",
  );
  assert.equal(headers["X-AppId"], "id");
  assert.equal(headers["X-Timestamp"], "1700000000");
  assert.equal(
    headers["X-Signature"],
    generateSignature("id", 1_700_000_000, "/api/v2/comment/1", "secret"),
  );
  assert.equal(headers["X-AppSecret"], undefined, "签名模式不应明文传 Secret");
});

test("DandanplayError 把 detail 放进 message（否则诊断信息全丢）", () => {
  // 实测踩过：detail 只存成属性时，上层 e.message 只有一句无信息量的
  // 「dandanplay 403 on ...」，服务端给出的具体原因（Invalid AppId 等）就丢了，
  // 日志里无法判断是凭据错还是签名错。
  const error = new DandanplayError(403, "Invalid AppId", "https://api.dandanplay.net/x");
  assert.match(error.message, /Invalid AppId/);
  assert.equal(error.status, 403);
  assert.equal(error.detail, "Invalid AppId");
});

test("DandanplayError 无 detail 时不产生多余分隔符", () => {
  const error = new DandanplayError(500, null, "https://x/y");
  assert.equal(error.message, "dandanplay 500 (https://x/y)");
});
