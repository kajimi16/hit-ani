/**
 * 个人访问令牌绑定路径的测试 —— 用户**最可能走的那条**。
 *
 * ## 为什么这条路径必须单独测
 *
 * `bindBgmAccount`（OAuth）有 9 处测试引用，而 `bindBgmPersonalToken`
 * 在此之前是 **0 处**。而现实是：
 *
 * - 设置页在未配置 OAuth 时**明确引导用户改用个人令牌**（「功能完全等价」）；
 * - 用户当前的部署正是「没有 BGM OAuth 凭据」。
 *
 * 也就是说**最可能被走的那条路，恰恰是没有测试的那条**。而它被本会话的多次
 * 重构动过：`fetchBgmIdentity` 与 `fetchTokenExpiry` 都加了超时、
 * `saveBinding` 被抽出并加入了冲突处理。
 *
 * 这条路径上的回归会直接表现为「用户绑不上 BGM」—— 正是用户报的故障。
 *
 * ## 与 OAuth 路径的关键差异（这些差异必须被断言）
 *
 * | | OAuth | 个人令牌 |
 * |---|---|---|
 * | `refreshToken` | 真实值 | **空串**（BGM 不发 refresh_token） |
 * | `personalToken` | false | **true** —— 决定令牌过期时是「报错要求重绑」还是「尝试刷新」 |
 * | `expiresAt` | 由 `expires_in` 推算 | 查 `token_status`，**查不到就假设一年** |
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { BgmAccountTakenError, bindBgmPersonalToken } from "@/lib/auth/bgm-oauth";
import { prisma } from "@/lib/prisma";

const REAL_FETCH = globalThis.fetch;
const EMAIL_PREFIX = "token-test-";

/** 让每个用例用独立的 BGM 账号 id —— `bgmUserId` 有唯一约束，复用会互相占用。 */
function bgmIdFor(suffix: string): number {
  let hash = 0;
  for (const ch of suffix) hash = (hash * 31 + ch.charCodeAt(0)) % 100000;
  return 900000 + hash;
}

/**
 * 桩掉 BGM 的两个端点。
 *
 * 响应形状取自真实返回：`/v0/me` 是 `{ id, username, nickname, avatar }`；
 * `token_status` 是 `{ expires }`（Unix 秒）。
 */
function stubBgm(input: {
  userId: number;
  username?: string;
  /** `/v0/me` 返回 401（令牌无效） */
  invalidToken?: boolean;
  /** `token_status` 的行为：正常 / 非 200 / 网络错误 */
  status?: "ok" | "http-error" | "network-error";
  expiresInSeconds?: number;
}): void {
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);

    if (url.includes("/v0/me")) {
      if (input.invalidToken) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: input.userId,
            username: input.username ?? "token-stub",
            nickname: "令牌测试",
            avatar: { large: "https://lain.bgm.tv/l.jpg", medium: "https://lain.bgm.tv/m.jpg", small: "https://lain.bgm.tv/s.jpg" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }

    if (url.includes("/token_status")) {
      if (input.status === "network-error") return Promise.reject(new Error("socket hang up"));
      if (input.status === "http-error") {
        return Promise.resolve(new Response("nope", { status: 403 }));
      }
      const expires = Math.floor(Date.now() / 1000) + (input.expiresInSeconds ?? 86400);
      return Promise.resolve(
        new Response(JSON.stringify({ expires }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;
}

async function makeUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${suffix}@stu.hit.edu.cn`,
      nickname: `令牌测试${suffix}`,
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

test("完整链路：校验令牌 → 查询到期 → 落库绑定", async () => {
  const bgmUserId = bgmIdFor("ok");
  stubBgm({ userId: bgmUserId, expiresInSeconds: 86400 * 30 });
  const userId = await makeUser("ok");

  const result = await bindBgmPersonalToken(userId, "stub-personal-token");
  assert.equal(result.bgmUserId, bgmUserId);
  assert.equal(result.username, "token-stub");

  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  assert.ok(binding, "绑定没有落库");
  assert.equal(binding.bgmUserId, bgmUserId);
  assert.equal(binding.accessToken, "stub-personal-token");
});

test("`personalToken` 必须为 true —— 它决定令牌过期时的行为", async () => {
  // 这个字段若写错，过期后会被当成 OAuth 令牌去「刷新」，
  // 而个人令牌没有 refresh_token，刷新必然失败 → 用户看到莫名的错误。
  stubBgm({ userId: bgmIdFor("flag"), status: "http-error" });
  const userId = await makeUser("flag");

  await bindBgmPersonalToken(userId, "tok");
  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  assert.equal(binding?.personalToken, true);
});

test("`refreshToken` 存空串（个人令牌没有它）", async () => {
  // 存空串而非 null：复用同一列，不改可空性。
  // 断言它是**空串**（而不是被写入了别的东西）—— 过期逻辑靠它区分两类令牌。
  stubBgm({ userId: bgmIdFor("refresh") });
  const userId = await makeUser("refresh");

  await bindBgmPersonalToken(userId, "tok");
  const binding = await prisma.bgmBinding.findUnique({ where: { userId } });
  assert.equal(binding?.refreshToken, "");
});

test("`token_status` 查不到时假设一年有效期（而不是报错或 null）", async () => {
  // BGM 对个人令牌常常不给 expires —— 若这里返回 null，`expiresAt` 会写入
  // 非法值或直接崩掉。文档注释写了「失败时返回 null 由调用方兜底」，
  // 这条断言锁住那个兜底确实存在。
  for (const status of ["http-error", "network-error"] as const) {
    stubBgm({ userId: bgmIdFor(`fallback-${status}`), status });
    const userId = await makeUser(`fallback-${status}`);

    const result = await bindBgmPersonalToken(userId, "tok");
    const days = (result.expiresAt.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 364 && days < 366, `${status} 应回退到约一年，实际 ${days.toFixed(1)} 天`);
  }
});

test("令牌无效（401）时抛出，且**不留下半截绑定**", async () => {
  stubBgm({ userId: bgmIdFor("invalid"), invalidToken: true });
  const userId = await makeUser("invalid");

  await assert.rejects(() => bindBgmPersonalToken(userId, "bad-token"), /令牌无效/);
  assert.equal(
    await prisma.bgmBinding.findUnique({ where: { userId } }),
    null,
    "令牌无效却写了绑定",
  );
});

test("同一 BGM 账号已被他人绑定时抛 BgmAccountTakenError", async () => {
  const bgmUserId = bgmIdFor("taken");
  stubBgm({ userId: bgmUserId });
  const first = await makeUser("taken-first");
  const second = await makeUser("taken-second");

  await bindBgmPersonalToken(first, "tok-1");
  await assert.rejects(
    () => bindBgmPersonalToken(second, "tok-2"),
    (error: unknown) => error instanceof BgmAccountTakenError,
  );
});

test("takeOver 时迁移绑定：旧账号解除、新账号建立", async () => {
  const bgmUserId = bgmIdFor("takeover");
  stubBgm({ userId: bgmUserId });
  const first = await makeUser("takeover-first");
  const second = await makeUser("takeover-second");

  await bindBgmPersonalToken(first, "tok-1");
  await bindBgmPersonalToken(second, "tok-2", { takeOver: true });

  assert.equal(
    await prisma.bgmBinding.findUnique({ where: { userId: first } }),
    null,
    "旧账号的绑定应被解除",
  );
  const moved = await prisma.bgmBinding.findUnique({ where: { userId: second } });
  assert.equal(moved?.bgmUserId, bgmUserId, "新账号应持有该 BGM 账号");

  // 全局唯一约束下不该出现两行
  const rows = await prisma.bgmBinding.findMany({ where: { bgmUserId } });
  assert.equal(rows.length, 1, "同一 BGM 账号只能有一条绑定");
});

test("同一账号重复绑定是更新而非冲突（换令牌重绑）", async () => {
  const bgmUserId = bgmIdFor("rebind");
  stubBgm({ userId: bgmUserId });
  const userId = await makeUser("rebind");

  await bindBgmPersonalToken(userId, "tok-old");
  stubBgm({ userId: bgmUserId, username: "token-stub-2" });
  await bindBgmPersonalToken(userId, "tok-new");

  const rows = await prisma.bgmBinding.findMany({ where: { userId } });
  assert.equal(rows.length, 1, "重复绑定不该产生两行");
  assert.equal(rows[0]?.accessToken, "tok-new", "应更新为新令牌");
  assert.equal(rows[0]?.bgmUsername, "token-stub-2");
});
