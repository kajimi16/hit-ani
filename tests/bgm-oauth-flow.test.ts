/**
 * Bangumi OAuth 绑定链路的集成测试。
 *
 * ## 为什么需要它
 *
 * 用户报「授权会报错」，而根因是**凭据为空**（`BGM_CLIENT_ID=""`）——
 * 也就是说这条链路**从未被真正跑通过**。没有凭据就永远验证不了，
 * 于是它一直停留在「看起来写完了」的状态。
 *
 * 这里用 stub 顶掉 BGM 的两个端点（换取 token、取身份），让
 * `bindBgmAccount` 走完整条路径并真的写库 —— 这样一旦用户填上真实凭据，
 * 它就是**第一次就能跑通**的，而不是又要现场调试。
 *
 * stubbed 的响应形状取自 BGM 的实际返回（`access_token` / `refresh_token` /
 * `expires_in`，以及 `/v0/me` 的 `id` / `username`）。
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { bindBgmAccount, BgmAccountTakenError } from "@/lib/auth/bgm-oauth";
import { prisma } from "@/lib/prisma";

const REAL_FETCH = globalThis.fetch;
/**
 * 每个用例用**独立的 BGM 账号 id**。
 *
 * `bgmUserId` 有唯一约束，而绑定是全局状态 —— 复用同一个 id 会让
 * 第一个绑定成功的用例把后续用例全部变成「已被占用」（实测过）。
 * 测试之间必须隔离，否则失败的是测试而不是被测代码。
 */
function bgmIdFor(suffix: string): number {
  let hash = 0;
  for (const ch of suffix) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  return 800000 + hash;
}
const EMAIL_PREFIX = "oauth-test-";

/** BGM 的 token 端点与 /v0/me 的 stub。 */
function stubBgm(input: {
  /** 必传：每个用例独立的 BGM 账号 id（见 bgmIdFor 的说明）。 */
  userId: number;
  username?: string;
  tokenFails?: boolean;
  meFails?: boolean;
}): void {
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);

    if (url.includes("/oauth/access_token")) {
      if (input.tokenFails) {
        return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
      }
      // 真实的 token 端点要求 form 编码的 body，这里顺带断言调用方发对了
      const body = String(init?.body ?? "");
      assert.match(body, /grant_type=authorization_code/, "必须以 authorization_code 模式换取 token");
      assert.match(body, /code=/, "必须带上授权码");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "stub-access-token",
            refresh_token: "stub-refresh-token",
            expires_in: 604800,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    if (url.includes("/v0/me")) {
      if (input.meFails) {
        return Promise.resolve(new Response(JSON.stringify({}), { status: 401 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            // userId 必传 —— 每个用例用自己的 id，避免跨用例互相占用
            id: input.userId!,
            username: input.username ?? "oauth-stub",
            nickname: "授权测试",
            avatar: {
              large: "https://lain.bgm.tv/l.jpg",
              medium: "https://lain.bgm.tv/m.jpg",
              small: "https://lain.bgm.tv/s.jpg",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;
}

const config = {
  clientId: "test-client",
  clientSecret: "test-secret",
  redirectUri: "http://localhost:3100/api/auth/bgm/callback",
};

async function makeUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${suffix}@stu.hit.edu.cn`,
      nickname: `OAuth测试${suffix}`,
      schoolId: "hit",
      passwordHash: "x",
    },
    select: { id: true },
  });
  return user.id;
}

before(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
});

after(async () => {
  globalThis.fetch = REAL_FETCH;
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
});

test("完整链路：用 code 换 token → 取身份 → 落库绑定", async () => {
  stubBgm({ userId: bgmIdFor("ok") });
  const userId = await makeUser("ok");

  const result = await bindBgmAccount(userId, config, "stub-code");
  assert.equal(result.bgmUserId, bgmIdFor("ok"));

  // 关键：真的写进库了，且字段完整
  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  assert.ok(binding, "绑定没有落库");
  assert.equal(binding.bgmUserId, bgmIdFor("ok"));
  assert.equal(binding.bgmUsername, "oauth-stub");
  assert.equal(binding.accessToken, "stub-access-token");
  assert.equal(binding.refreshToken, "stub-refresh-token", "OAuth 必须有 refresh_token 才能续期");
  assert.equal(binding.personalToken, false, "OAuth 路径不是个人令牌");
  // expiresAt 应按 expires_in 推算（604800 秒 ≈ 7 天）
  const days = (binding.expiresAt.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1, `到期时间应在 7 天后，实际 ${days.toFixed(2)} 天`);
});

test("换取 token 失败时抛出，且**不留下半截绑定**", async () => {
  stubBgm({ userId: bgmIdFor("tokenfail"), tokenFails: true });
  const userId = await makeUser("tokenfail");

  await assert.rejects(() => bindBgmAccount(userId, config, "bad-code"));
  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  assert.equal(binding, null, "换 token 失败却写了绑定");
});

test("身份接口失败（令牌无效）时抛出，且不落库", async () => {
  stubBgm({ userId: bgmIdFor("mefail"), meFails: true });
  const userId = await makeUser("mefail");

  await assert.rejects(() => bindBgmAccount(userId, config, "code"), /令牌无效/);
  assert.equal(await prisma.bgmBinding.findUnique({ where: { userId } }), null);
});

test("同一 BGM 账号绑到第二个本地账号 → 抛 BgmAccountTakenError", async () => {
  // 这个用例**刻意**让两个本地账号指向同一个 BGM 账号
  stubBgm({ userId: bgmIdFor("shared") });
  const first = await makeUser("first");
  const second = await makeUser("second");

  await bindBgmAccount(first, config, "code-1");
  await assert.rejects(
    () => bindBgmAccount(second, config, "code-2"),
    (error: unknown) => error instanceof BgmAccountTakenError,
  );
});

test("同一本地账号重复绑定 → 更新而不是报冲突（换令牌重绑的路径）", async () => {
  const bgmUserId = bgmIdFor("rebind");
  stubBgm({ userId: bgmUserId });
  const userId = await makeUser("rebind");

  await bindBgmAccount(userId, config, "code-1");

  // 换一个 BGM 用户名模拟「重新授权后信息有变」
  stubBgm({ userId: bgmUserId, username: "oauth-stub-2" });
  await bindBgmAccount(userId, config, "code-2");

  const rows = await prisma.bgmBinding.findMany({ where: { userId } });
  assert.equal(rows.length, 1, "重复绑定不该产生两行");
  assert.equal(rows[0].bgmUsername, "oauth-stub-2", "应更新为新值");
});
