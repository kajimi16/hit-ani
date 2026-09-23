/**
 * BGM 客户端「空响应体」处理单测。
 *
 * 真实事故：`POST /v0/users/-/collections/{subject_id}` 实测返回 **202 + content-length: 0**。
 * 原实现只特判 204，于是空 body 被丢给 `response.json()`，
 * 抛 "Unexpected end of JSON input" —— 一次**已经成功**的上游写入被误判为失败，
 * 前端显示「同步到 Bangumi 失败」。
 *
 * 这组测试锁死：202 / 204 / 200+空体 都必须被当作成功且无返回值；
 * 而非法 JSON（有内容但解析不了）必须仍然报错，不能被静默吞掉。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BgmApiError, postUserCollection, putEpisodeCollection } from "@/lib/bgm/client";

const REAL_FETCH = globalThis.fetch;

function stubResponse(status: number, body: string, contentType = "application/json"): void {
  globalThis.fetch = (async () =>
    new Response(body.length === 0 ? null : body, {
      status,
      headers: { "Content-Type": contentType },
    })) as typeof fetch;
}

async function withStub(
  status: number,
  body: string,
  fn: () => Promise<void>,
  contentType?: string,
): Promise<void> {
  stubResponse(status, body, contentType);
  try {
    await fn();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

test("202 + 空 body 视为成功（真实响应形态）", async () => {
  await withStub(202, "", async () => {
    await assert.doesNotReject(() => postUserCollection(8, { type: 2 }));
  });
});

test("204 + 空 body 视为成功", async () => {
  await withStub(204, "", async () => {
    await assert.doesNotReject(() => putEpisodeCollection(8, 2));
  });
});

test("200 + 空 body 视为成功", async () => {
  await withStub(200, "", async () => {
    await assert.doesNotReject(() => postUserCollection(8, { type: 2 }));
  });
});

test("有响应体时正常解析", async () => {
  stubResponse(200, JSON.stringify({ id: 8, name: "test" }));
  try {
    const { searchSubjects } = await import("@/lib/bgm/client");
    const result = await searchSubjects({ keyword: "x" });
    assert.equal((result as unknown as { id: number }).id, 8);
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("非法 JSON 仍然报错，不被静默吞掉", async () => {
  await withStub(200, "<html>gateway error</html>", async () => {
    await assert.rejects(
      () => postUserCollection(8, { type: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof BgmApiError, `期望 BgmApiError，实际 ${String(error)}`);
        assert.equal(error.status, 200);
        return true;
      },
    );
  }, "text/html");
});

test("HTTP 错误状态仍然抛 BgmApiError", async () => {
  await withStub(400, JSON.stringify({ title: "Bad Request" }), async () => {
    await assert.rejects(
      () => postUserCollection(8, { type: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof BgmApiError);
        assert.equal(error.status, 400);
        return true;
      },
    );
  });
});
