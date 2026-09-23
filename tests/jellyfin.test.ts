/**
 * Jellyfin 客户端单测 —— 用桩替换上游，不依赖 Docker 或真实服务器。
 *
 * 为什么必须有：此前的验证全靠「跑一个真 Jellyfin 容器」，那既慢又不可持续
 * （CI 里没有容器）。契约层面的东西应该用桩测 —— 这正是那份 OpenAPI 规范的价值。
 *
 * 覆盖三类最容易出错、且线上难以发现的问题：
 *  1. **请求头格式**。`Authorization: MediaBrowser ...` 写错会得到 400/401，
 *     而且服务端只回一句含糊的异常（实测 Jellyfin 会抛 request.App 为 null）。
 *  2. **ticks → 毫秒换算**。Jellyfin 用 .NET ticks（100 纳秒），差一个数量级
 *     会让「续播位置」变成几毫秒或几小时，用户完全无法察觉原因。
 *  3. **直连地址的构造**。`static=true` 决定是否转码；漏了它 Jellyfin 会转码，
 *     直接吃满服务器 CPU。`api_key` 漏了则播不了。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JellyfinError,
  authenticate,
  authorizationHeader,
  buildImageUrl,
  buildStreamUrl,
  isLoopbackUrl,
  normalizeBaseUrl,
  probeServer,
  searchSeries,
  ticksToMs,
} from "@/lib/media/jellyfin";

const REAL_FETCH = globalThis.fetch;

interface StubResponse {
  status?: number;
  body?: unknown;
  /** 原始文本响应（用于测非 JSON 场景） */
  raw?: string;
  contentType?: string;
}

/** 记录最后一次请求，供断言请求头与 URL。 */
let lastRequest: { url: string; method: string; headers: Record<string, string>; body?: string } | null = null;
/** 实际发出的请求次数 —— 用于验证「被拦截时没有发出任何请求」。 */
let fetchCallCount = 0;

function stubFetch(response: StubResponse): void {
  lastRequest = null;
  fetchCallCount = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCallCount += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    lastRequest = {
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: typeof init?.body === "string" ? init.body : undefined,
    };

    const status = response.status ?? 200;
    const text =
      response.raw !== undefined
        ? response.raw
        : response.body === undefined
          ? ""
          : JSON.stringify(response.body);

    return new Response(text.length === 0 ? null : text, {
      status,
      headers: { "Content-Type": response.contentType ?? "application/json" },
    });
  }) as typeof fetch;
}

/** 模拟底层网络错误（带 cause.code，与实际 undici 行为一致）。 */
function stubFetchNetworkError(code: string): void {
  lastRequest = null;
  fetchCallCount = 0;
  globalThis.fetch = (async () => {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
    throw error;
  }) as typeof fetch;
}

async function withStub(
  response: StubResponse,
  fn: () => Promise<void>,
): Promise<void> {
  stubFetch(response);
  try {
    await fn();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

/* ---------------------------------------------------------------- *
 * URL 归一化
 * ---------------------------------------------------------------- */

test("normalizeBaseUrl 补协议、去尾斜杠", () => {
  assert.equal(normalizeBaseUrl("192.168.1.10:8096"), "http://192.168.1.10:8096");
  assert.equal(normalizeBaseUrl("http://jellyfin.lan:8096/"), "http://jellyfin.lan:8096");
  assert.equal(normalizeBaseUrl("https://media.example.com///"), "https://media.example.com");
  assert.equal(normalizeBaseUrl("  http://a.b  "), "http://a.b");
});

test("normalizeBaseUrl 保留子路径（反向代理场景）", () => {
  assert.equal(normalizeBaseUrl("https://example.com/jellyfin/"), "https://example.com/jellyfin");
});

test("normalizeBaseUrl 对非法输入返回 null", () => {
  assert.equal(normalizeBaseUrl(""), null);
  assert.equal(normalizeBaseUrl("   "), null);
  assert.equal(normalizeBaseUrl("http://"), null);
});

/* ---------------------------------------------------------------- *
 * 认证头
 * ---------------------------------------------------------------- */

test("authorizationHeader 生成 MediaBrowser 格式", () => {
  const header = authorizationHeader("tok123", "dev-1");
  assert.match(header, /^MediaBrowser /);
  assert.match(header, /Client="hit-ani"/);
  assert.match(header, /DeviceId="dev-1"/);
  assert.match(header, /Token="tok123"/);
});

test("authorizationHeader 未登录时不含 Token（但仍带设备信息）", () => {
  const header = authorizationHeader(undefined);
  assert.ok(!header.includes("Token="), "未认证不应出现 Token 字段");
  // 设备信息必须在 —— Jellyfin 靠它构造 request.App，缺了会 400
  assert.match(header, /Client=/);
  assert.match(header, /DeviceId=/);
});

test("所有请求都带 Authorization 头（含登录请求）", async () => {
  await withStub({ body: { AccessToken: "t", User: { Id: "u" } } }, async () => {
    await authenticate("http://jf.lan:8096", "admin", "pw", { allowPrivateHost: true });
    assert.ok(lastRequest?.headers.Authorization, "登录请求也必须有 Authorization 头");
    assert.match(lastRequest.headers.Authorization, /^MediaBrowser /);
  });
});

/* ---------------------------------------------------------------- *
 * ticks 换算
 * ---------------------------------------------------------------- */

test("ticksToMs 按 .NET ticks（100 纳秒）换算", () => {
  // 1 tick = 100ns = 1e-4 ms
  assert.equal(ticksToMs(10_000), 1); // 10k ticks = 1ms
  assert.equal(ticksToMs(100_000_000), 10_000); // 1e8 ticks = 10s
  // 一集 24 分钟 = 1440 秒 = 1.44e10 ticks
  assert.equal(ticksToMs(14_400_000_000), 1_440_000);
});

test("ticksToMs 对 null/undefined/非数字返回 null 而非 0", () => {
  // 返回 null 而非 0 很重要：0 会被误当作「从头开始」，而 null 表示「未知」
  assert.equal(ticksToMs(null), null);
  assert.equal(ticksToMs(undefined), null);
  assert.equal(ticksToMs(Number.NaN), null);
  assert.equal(ticksToMs(Number.POSITIVE_INFINITY), null);
});

/* ---------------------------------------------------------------- *
 * 直连地址构造（最关键的一组）
 * ---------------------------------------------------------------- */

test("buildStreamUrl 必须带 static=true（否则 Jellyfin 会转码）", () => {
  const url = buildStreamUrl("http://jf.lan:8096", "abc123", "tok");
  assert.match(url, /static=true/, "缺 static=true 会导致服务端转码，吃满 CPU");
});

test("buildStreamUrl 带 api_key（video 元素无法自定义请求头）", () => {
  const url = buildStreamUrl("http://jf.lan:8096", "abc123", "secret-token");
  assert.match(url, /api_key=secret-token/);
  assert.ok(url.startsWith("http://jf.lan:8096/Videos/abc123/stream"), url);
});

test("buildStreamUrl 对 itemId 做 URL 编码", () => {
  const url = buildStreamUrl("http://jf.lan:8096", "a/b?c", "tok");
  assert.ok(!url.includes("/Videos/a/b?c/"), "id 必须编码，否则路径会被拆开");
});

test("buildImageUrl 指向 Jellyfin 自身（图片也直连，不过我们的服务）", () => {
  const url = buildImageUrl("http://jf.lan:8096", "item1");
  assert.ok(url.startsWith("http://jf.lan:8096/Items/item1/Images/Primary"));
  assert.match(url, /maxHeight=300/);
});

/* ---------------------------------------------------------------- *
 * 登录
 * ---------------------------------------------------------------- */

test("authenticate 解析出 token 与用户信息", async () => {
  await withStub(
    {
      body: {
        AccessToken: "tok-abc",
        ServerId: "srv-1",
        User: { Id: "user-1", Name: "admin", Policy: { IsAdministrator: true } },
      },
    },
    async () => {
      const result = await authenticate("http://jf.lan:8096", "admin", "pw", { allowPrivateHost: true });
      assert.equal(result.accessToken, "tok-abc");
      assert.equal(result.userId, "user-1");
      assert.equal(result.userName, "admin");
      assert.equal(result.isAdministrator, true);
      assert.equal(result.serverId, "srv-1");
    },
  );
});

test("authenticate 发送 {Username, Pw} 请求体", async () => {
  await withStub({ body: { AccessToken: "t", User: { Id: "u" } } }, async () => {
    await authenticate("http://jf.lan:8096", "admin", "s3cret", { allowPrivateHost: true });
    const body = JSON.parse(lastRequest?.body ?? "{}") as Record<string, unknown>;
    assert.equal(body.Username, "admin");
    assert.equal(body.Pw, "s3cret");
  });
});

test("authenticate 在缺少 token 时报错（不返回半成品）", async () => {
  await withStub({ body: { User: { Id: "u" } } }, async () => {
    await assert.rejects(
      () => authenticate("http://jf.lan:8096", "admin", "pw", { allowPrivateHost: true }),
      (error: unknown) => {
        assert.ok(error instanceof JellyfinError);
        assert.match(error.message, /未返回访问令牌/);
        return true;
      },
    );
  });
});

test("401 给出可行动的中文提示", async () => {
  await withStub({ status: 401, body: { title: "Unauthorized" } }, async () => {
    await assert.rejects(
      () => authenticate("http://jf.lan:8096", "admin", "wrong", { allowPrivateHost: true }),
      (error: unknown) => {
        assert.ok(error instanceof JellyfinError);
        assert.equal(error.status, 401);
        assert.match(error.message, /用户名或密码错误/);
        return true;
      },
    );
  });
});

/* ---------------------------------------------------------------- *
 * 探测
 * ---------------------------------------------------------------- */

test("probeServer 返回服务器信息", async () => {
  await withStub(
    { body: { ServerName: "lab", Version: "12.1.0", Id: "x", StartupWizardCompleted: true } },
    async () => {
      const info = await probeServer("http://jf.lan:8096", { allowPrivateHost: true });
      assert.equal(info.ServerName, "lab");
      assert.equal(info.Version, "12.1.0");
    },
  );
});

test("probeServer 识别出「不是 Jellyfin」的响应", async () => {
  await withStub({ body: { hello: "world" } }, async () => {
    await assert.rejects(
      () => probeServer("http://other.lan", { allowPrivateHost: true }),
      (error: unknown) => {
        assert.ok(error instanceof JellyfinError);
        assert.match(error.message, /不是 Jellyfin/);
        return true;
      },
    );
  });
});

/* ---------------------------------------------------------------- *
 * 网络错误 → 可行动的中文
 * ---------------------------------------------------------------- */

test("ECONNREFUSED 提示端口可能不对", async () => {
  stubFetchNetworkError("ECONNREFUSED");
  try {
    await assert.rejects(
      () => probeServer("http://jf.lan:9999", { allowPrivateHost: true }),
      (error: unknown) => {
        assert.ok(error instanceof JellyfinError);
        assert.match(error.message, /连接被拒绝/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("ENOTFOUND 提示域名解析失败", async () => {
  stubFetchNetworkError("ENOTFOUND");
  try {
    await assert.rejects(
      () => probeServer("http://no-such-host.invalid", { allowPrivateHost: true }),
      (error: unknown) => {
        assert.ok(error instanceof JellyfinError);
        assert.match(error.message, /域名解析失败/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

test("网络错误信息里不含裸露的 'fetch failed'", async () => {
  stubFetchNetworkError("ECONNRESET");
  try {
    const error = await probeServer("http://jf.lan:8096", { allowPrivateHost: true }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(error);
    assert.ok(
      !/^fetch failed$/.test(error.message),
      `错误信息应可行动，实际为「${error.message}」`,
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

/* ---------------------------------------------------------------- *
 * 搜索
 * ---------------------------------------------------------------- */

test("searchSeries 传对查询参数", async () => {
  await withStub({ body: { Items: [{ Id: "s1", Name: "某番" }] } }, async () => {
    const items = await searchSeries("http://jf.lan:8096", "tok", "user-1", "某番", { allowPrivateHost: true });
    assert.equal(items.length, 1);
    assert.equal(items[0].Name, "某番");

    const url = new URL(lastRequest!.url);
    assert.equal(url.pathname, "/Items");
    assert.equal(url.searchParams.get("searchTerm"), "某番");
    assert.equal(url.searchParams.get("includeItemTypes"), "Series");
    assert.equal(url.searchParams.get("recursive"), "true");
    assert.equal(url.searchParams.get("userId"), "user-1");
  });
});

test("searchSeries 对空响应返回空数组（不抛错）", async () => {
  await withStub({ body: {} }, async () => {
    const items = await searchSeries("http://jf.lan:8096", "tok", "u", "x", { allowPrivateHost: true });
    assert.deepEqual(items, []);
  });
});

/* ---------------------------------------------------------------- *
 * SSRF 放开内网（Jellyfin 常在局域网）
 * ---------------------------------------------------------------- */

test("allowPrivateHost 允许内网地址（自建 Jellyfin 的常态）", async () => {
  await withStub(
    { body: { ServerName: "lab", Version: "1", Id: "x", StartupWizardCompleted: true } },
    async () => {
      const info = await probeServer("http://192.168.1.10:8096", { allowPrivateHost: true });
      assert.equal(info.ServerName, "lab");
    },
  );
});

test("未放开内网时拒绝内网地址，且不发出任何请求", async () => {
  // 装一个「总是成功」的 fetch —— 如果校验没拦住，它就会被调用
  stubFetch({ body: { ServerName: "evil", Version: "1", Id: "x" } });
  try {
    await assert.rejects(
      () => probeServer("http://192.168.1.10:8096"),
      (error: unknown) => {
        assert.match(String(error), /内网/);
        return true;
      },
    );
    assert.equal(fetchCallCount, 0, "SSRF 校验必须在发起请求之前拦截");
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
});

/* ---------------------------------------------------------------- *
 * 环回地址识别（会让其他用户播不了的配置错误）
 * ---------------------------------------------------------------- */

test("isLoopbackUrl 识别 localhost / 127.0.0.1 / ::1", () => {
  // 这是最危险的配置错误：只有服务器本机能播，其他用户全播不了，
  // 而且从服务器上测一切正常，极难察觉。
  assert.equal(isLoopbackUrl("localhost"), true);
  assert.equal(isLoopbackUrl("localhost:8096"), true);
  assert.equal(isLoopbackUrl("http://localhost:8096"), true);
  assert.equal(isLoopbackUrl("http://127.0.0.1:8096"), true);
  assert.equal(isLoopbackUrl("http://127.1.2.3:8096"), false); // 非标准环回写法，按普通内网处理
  assert.equal(isLoopbackUrl("http://[::1]:8096"), true);
  assert.equal(isLoopbackUrl("http://foo.localhost:8096"), true);
});

test("isLoopbackUrl 放行局域网与公网地址", () => {
  assert.equal(isLoopbackUrl("http://10.249.61.10:8096"), false);
  assert.equal(isLoopbackUrl("http://192.168.1.10:8096"), false);
  assert.equal(isLoopbackUrl("https://media.example.com"), false);
  assert.equal(isLoopbackUrl("jellyfin.lan:8096"), false);
});

test("isLoopbackUrl 对空/非法输入返回 false（不误报）", () => {
  assert.equal(isLoopbackUrl(""), false);
  assert.equal(isLoopbackUrl("   "), false);
});
