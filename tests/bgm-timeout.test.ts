/**
 * Bangumi 客户端超时与重试策略单测。
 *
 * 背景（真实事故）：导入 BGM 收藏时，代理偶发把连接丢进黑洞 —— TCP 建连后不应答。
 * Node 的 `fetch` 对响应体**没有默认超时**，于是请求永久挂起；而 `withRetry` 只对
 * 抛出的异常重试，挂起不抛异常，整条导入链路无声卡死（UI 永远显示「导入中」）。
 *
 * 这组测试锁死两件事：
 *  1. 请求必须有内置超时，且超时以 `TimeoutError` 形式抛出（可被识别、可被重试）
 *  2. 调用方主动取消（`AbortError`）**不得**被误判为可重试 —— 否则会把用户已放弃的工作重新捡起来
 *
 * 超时本身依赖平台计时器（`AbortSignal.timeout`），故这里必须走真实时钟；
 * 测试把超时压到几十毫秒以保证总耗时可控。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { BgmApiError, getSubject, isRetryable } from "@/lib/bgm/client";

const REAL_FETCH = globalThis.fetch;

/**
 * 模拟「连上了但永远不回应」的上游。
 * 忠实复刻真实 fetch 的行为：只在 signal 中止时 reject，且带上中止原因。
 */
function stubHangingFetch(): void {
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    const signal = init?.signal;
    if (!signal) return promise; // 永不 settle —— 正是「无超时」时的行为
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    return promise;
  }) as typeof fetch;
}

async function withHangingFetch(fn: () => Promise<void>): Promise<void> {
  stubHangingFetch();
  try {
    await fn();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

test("请求自带超时：上游挂起时以 TimeoutError 失败", async () => {
  await withHangingFetch(async () => {
    await assert.rejects(
      () => getSubject(8, { timeoutMs: 50 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "TimeoutError", `期望 TimeoutError，实际 ${error.name}`);
        return true;
      },
    );
  });
});

test("超时被判定为可重试", async () => {
  await withHangingFetch(async () => {
    const error = await getSubject(8, { timeoutMs: 50 }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error);
    assert.equal(isRetryable(error), true, "TimeoutError 必须可重试");
  });
});

test("调用方主动取消抛错，且不判定为可重试", async () => {
  await withHangingFetch(async () => {
    const controller = new AbortController();
    // 超时设得很长，确保先触发的是调用方取消
    const promise = getSubject(8, { signal: controller.signal, timeoutMs: 1_000 });
    controller.abort(new Error("用户离开页面"));

    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, "TimeoutError");
    assert.equal(isRetryable(error), false, "主动取消不得重试");
  });
});

test("调用方已取消时立即失败，不等待超时", async () => {
  await withHangingFetch(async () => {
    const controller = new AbortController();
    controller.abort(new Error("已取消"));
    const error = await getSubject(8, { signal: controller.signal, timeoutMs: 1_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error instanceof Error);
    assert.equal(isRetryable(error), false);
  });
});

test("HTTP 错误的重试判定：429/5xx 可重试，4xx 不可", () => {
  const mk = (status: number) => new BgmApiError(status, null, "https://api.bgm.tv/x");
  assert.equal(isRetryable(mk(429)), true);
  assert.equal(isRetryable(mk(500)), true);
  assert.equal(isRetryable(mk(502)), true);
  assert.equal(isRetryable(mk(404)), false);
  assert.equal(isRetryable(mk(400)), false);
  assert.equal(isRetryable(mk(401)), false);
  assert.equal(isRetryable(new Error("random")), false);
});

/**
 * 网络层瞬时错误必须可重试。
 *
 * 真实事故：经代理访问 BGM 时偶发 `TypeError: fetch failed`
 * （底层 `ECONNRESET`），实测约 1/16。它**既不是** `BgmApiError`
 * （没有 HTTP 状态码）也**不是** `TimeoutError`，于是被旧实现判为不可重试 ——
 * 用户侧表现为「刷新一下就报加载失败」。
 */
test("网络层瞬时错误可重试（undici 把原因藏在 cause 里）", () => {
  const undici = (code: string, name = "Error") => {
    const cause = new Error("socket hang up");
    cause.name = name;
    Object.assign(cause, { code });
    const error = new TypeError("fetch failed");
    Object.assign(error, { cause });
    return error;
  };

  for (const code of [
    "ECONNRESET",
    "ECONNREFUSED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ]) {
    assert.equal(isRetryable(undici(code)), true, `${code} 应可重试`);
  }
});

test("嵌套在 AggregateError 里的原因也能被找到", () => {
  // undici 在解析到多个地址时会把每个失败包进 `errors[]`，
  // 只查第一层 cause 会漏掉。
  const ipv4 = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const ipv6 = Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
  const aggregate = new AggregateError([ipv4, ipv6], "all addresses failed");
  const error = Object.assign(new TypeError("fetch failed"), { cause: aggregate });

  assert.equal(isRetryable(error), true);
});

test("不可自愈的错误码不重试", () => {
  // 这些说明请求本身有问题，重试只是浪费时间和配额。
  for (const code of ["ENOTSUP", "EINVAL", "EPERM", "UND_ERR_INVALID_ARG"]) {
    const cause = Object.assign(new Error("bad"), { code });
    const error = Object.assign(new TypeError("fetch failed"), { cause });
    assert.equal(isRetryable(error), false, `${code} 不该重试`);
  }
});

test("主动取消优先于网络错误判定，即使被包成 fetch failed", () => {
  // 中止也可能走 undici 的错误路径。若不先排除 AbortError，
  // 用户离开页面反而会触发一串重试。
  const abort = new Error("已取消");
  abort.name = "AbortError";
  Object.assign(abort, { code: "ECONNRESET" });
  const wrapped = Object.assign(new TypeError("fetch failed"), { cause: abort });
  assert.equal(isRetryable(wrapped), false);
});

test("没有可识别错误码的普通 Error 不重试（保持既有判定）", () => {
  assert.equal(isRetryable(new Error("random")), false);
  assert.equal(isRetryable(new TypeError("fetch failed")), false);
  assert.equal(isRetryable(null), false);
  assert.equal(isRetryable("boom"), false);
});
