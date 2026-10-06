/**
 * QQ 绑定路径的测试。
 *
 * ## 为什么需要它
 *
 * `bindQqAccount` / `QqAccountTakenError` / `fetchQqUserInfo` 在 `tests/` 里
 * 此前是 **0 处引用** —— 而同类的 BGM 路径有 9 处。
 *
 * 尤其 `qq-oauth.ts` 里那处
 * `catch (error) { if (isUniqueViolation(error)) throw new QqAccountTakenError(openId) }`
 * 正是为**用户实际报过的那个 BGM 缺陷**（`Unique constraint failed on
 * (bgmUserId)`）写的同款修复 —— 同属本会话新增、零覆盖。
 *
 * 与 BGM 的区别（**这些差异必须被断言**）：
 *
 * | | BGM | QQ |
 * |---|---|---|
 * | 冲突后 | 可 `takeOver` 迁移（回调里能弹确认） | **不迁移**，只报错 |
 * | 换绑 | 覆盖 | **覆盖**（同一账号重绑是 update） |
 *
 * QQ 在当前部署不可达（没有 QQ OAuth 凭据），但代码路径是完整的 ——
 * 一旦配上凭据就会走这里。
 *
 * ## 桩要覆盖的三种响应形态
 *
 * QQ 的接口**不保证 JSON**：`fmt=json` 在部分网关下仍回落为 form 编码，
 * 而 `/me` 返回的是 JSONP（`callback( {...} );`）。代码里对这三种都有兼容分支，
 * 因此桩要把它们都覆盖到 —— 否则兼容分支就是未被执行的死代码。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { QqAccountTakenError, bindQqAccount, unbindQqAccount } from "@/lib/auth/qq-oauth";
import { prisma } from "@/lib/prisma";

const REAL_FETCH = globalThis.fetch;
const EMAIL_PREFIX = "qq-test-";

const config = {
  appId: "test-app-id",
  appKey: "test-app-key",
  redirectUri: "http://localhost:3100/api/auth/qq/callback",
};

function openIdFor(suffix: string): string {
  return `OPENID-${suffix.toUpperCase()}`;
}

/**
 * 桩掉 QQ 的四个端点。
 *
 * `tokenFormat` 与 `openIdFormat` 用来覆盖真实世界里并存的几种响应形态。
 */
function stubQq(input: {
  openId: string;
  /** token 端点：json（正常）/ form（部分网关回落）/ error */
  tokenFormat?: "json" | "form" | "error";
  /** `/me`：jsonp（QQ 实际返回）/ json（部分情况） */
  openIdFormat?: "jsonp" | "json";
  /** 用户信息：正常 / ret 非 0（令牌无效等） */
  userInfo?: "ok" | "error" | "no-avatar";
  unionId?: string;
}): void {
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);

    if (url.includes("/oauth2.0/token")) {
      if (input.tokenFormat === "error") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "invalid_grant", error_description: "code 已过期" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      // 顺带断言调用方发对了参数
      assert.match(url, /grant_type=authorization_code/);
      assert.match(url, /code=/);
      const body =
        input.tokenFormat === "form"
          ? `access_token=stub-qq-token&expires_in=7776000&refresh_token=r1`
          : JSON.stringify({ access_token: "stub-qq-token", expires_in: 7776000 });
      return Promise.resolve(new Response(body, { status: 200 }));
    }

    if (url.includes("/oauth2.0/me")) {
      const payload = JSON.stringify({
        openid: input.openId,
        ...(input.unionId ? { unionid: input.unionId } : {}),
      });
      // QQ 实际返回 JSONP：`callback( {...} );`
      const body = input.openIdFormat === "json" ? payload : `callback( ${payload} );`;
      return Promise.resolve(new Response(body, { status: 200 }));
    }

    if (url.includes("/user/get_user_info")) {
      if (input.userInfo === "error") {
        return Promise.resolve(
          new Response(JSON.stringify({ ret: 100016, msg: "access token check failed" }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            ret: 0,
            nickname: "QQ测试用户",
            figureurl_qq_2: input.userInfo === "no-avatar" ? undefined : "https://q.qlogo.cn/qq.png",
            figureurl_qq_1: "https://q.qlogo.cn/qq-small.png",
          }),
          { status: 200 },
        ),
      );
    }

    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;
}

async function makeUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${suffix}@stu.hit.edu.cn`,
      nickname: `QQ测试${suffix}`,
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

test("完整链路：换 token → 取 openid → 取用户信息 → 落库", async () => {
  const openId = openIdFor("ok");
  stubQq({ openId, unionId: "UNION-1" });
  const userId = await makeUser("ok");

  const result = await bindQqAccount(userId, config, "stub-code");
  assert.equal(result.openId, openId);
  assert.equal(result.nickname, "QQ测试用户");

  const binding = await prisma.qqBinding.findUnique({ where: { userId } });
  assert.ok(binding, "绑定没有落库");
  assert.equal(binding.openId, openId);
  assert.equal(binding.unionId, "UNION-1", "unionId 应一并存下");
});

test("`/me` 返回 JSONP（QQ 的实际形态）也能解析", async () => {
  // 代码里有 `text.replace(/^callback\s*\(\s*/, "").replace(/\s*\)\s*;?\s*$/, "")`
  // 这条兼容分支 —— 若不测它，它是死代码，而线上必然是 JSONP。
  const openId = openIdFor("jsonp");
  stubQq({ openId, openIdFormat: "jsonp" });
  const userId = await makeUser("jsonp");

  const result = await bindQqAccount(userId, config, "code");
  assert.equal(result.openId, openId, "JSONP 未被剥壳");
});

test("token 端点回落为 form 编码也能解析", async () => {
  // 代码注释写了「fmt=json 在部分网关下仍回落为 form 编码」，因此有
  // `parseFormEncoded` 分支。这里覆盖它。
  const openId = openIdFor("form");
  stubQq({ openId, tokenFormat: "form" });
  const userId = await makeUser("form");

  const result = await bindQqAccount(userId, config, "code");
  assert.equal(result.openId, openId);
  assert.ok(await prisma.qqBinding.findUnique({ where: { userId } }));
});

test("换 token 失败时抛出，且**不留下半截绑定**", async () => {
  stubQq({ openId: openIdFor("tokfail"), tokenFormat: "error" });
  const userId = await makeUser("tokfail");

  await assert.rejects(() => bindQqAccount(userId, config, "bad-code"), /code 已过期/);
  assert.equal(await prisma.qqBinding.findUnique({ where: { userId } }), null);
});

test("取用户信息失败时抛出，且不落库", async () => {
  stubQq({ openId: openIdFor("infofail"), userInfo: "error" });
  const userId = await makeUser("infofail");

  await assert.rejects(() => bindQqAccount(userId, config, "code"), /access token check failed/);
  assert.equal(await prisma.qqBinding.findUnique({ where: { userId } }), null);
});

test("没有头像时 nickname 仍返回（avatar 不是必需字段）", async () => {
  const openId = openIdFor("noavatar");
  stubQq({ openId, userInfo: "no-avatar" });
  const userId = await makeUser("noavatar");

  const result = await bindQqAccount(userId, config, "code");
  assert.equal(result.nickname, "QQ测试用户");
  assert.ok(await prisma.qqBinding.findUnique({ where: { userId } }));
});

test("同一个 QQ 绑到第二个账号 → 抛 QqAccountTakenError（而不是 Prisma 原文）", async () => {
  // 这正是用户实际报过的 BGM 缺陷的 QQ 版本：
  // `upsert({ where: { userId } })` 只按主键判断，第二个账号会走 create
  // 分支撞上 openId 的唯一约束 —— 不处理的话界面显示
  // `Unique constraint failed on the fields: (openId)`。
  const openId = openIdFor("shared");
  stubQq({ openId });
  const first = await makeUser("shared-first");
  const second = await makeUser("shared-second");

  await bindQqAccount(first, config, "code-1");
  await assert.rejects(
    () => bindQqAccount(second, config, "code-2"),
    (error: unknown) => error instanceof QqAccountTakenError,
  );
});

test("冲突错误的信息可展示，且不含 Prisma 内部字样", async () => {
  const openId = openIdFor("msg");
  stubQq({ openId });
  const first = await makeUser("msg-first");
  const second = await makeUser("msg-second");
  await bindQqAccount(first, config, "code-1");

  try {
    await bindQqAccount(second, config, "code-2");
    assert.fail("应当抛出");
  } catch (error) {
    assert.ok(error instanceof QqAccountTakenError);
    assert.equal(error.openId, openId);
    assert.match(error.message, /已经绑定到本站的另一个账号/);
    assert.match(error.message, /解除绑定/, "应告诉用户下一步做什么");
    assert.equal(
      /prisma|Unique constraint|invocation/i.test(error.message),
      false,
      "不该把 Prisma 原文漏给用户",
    );
  }
});

test("QQ 冲突**不做**迁移 —— 与 BGM 不同（那边回调里能弹确认）", async () => {
  // BGM 有 `takeOver` 是因为它是「贴令牌 + 界面确认」的形态；
  // QQ 是跳转式 OAuth，回调里没有地方确认，因此只能报错。
  const openId = openIdFor("nomigrate");
  stubQq({ openId });
  const first = await makeUser("nomigrate-first");
  const second = await makeUser("nomigrate-second");

  await bindQqAccount(first, config, "code-1");
  await assert.rejects(() => bindQqAccount(second, config, "code-2"));

  // 原持有者的绑定必须**完好无损**
  const stillFirst = await prisma.qqBinding.findUnique({ where: { userId: first } });
  assert.equal(stillFirst?.openId, openId, "冲突时不该解除原持有者的绑定");
  assert.equal(await prisma.qqBinding.findUnique({ where: { userId: second } }), null);
});

test("同一账号重复绑定是更新（换 QQ 重绑）", async () => {
  const first = openIdFor("rebind-1");
  const second = openIdFor("rebind-2");
  stubQq({ openId: first });
  const userId = await makeUser("rebind");

  await bindQqAccount(userId, config, "code-1");
  stubQq({ openId: second });
  await bindQqAccount(userId, config, "code-2");

  const rows = await prisma.qqBinding.findMany({ where: { userId } });
  assert.equal(rows.length, 1, "重复绑定不该产生两行");
  assert.equal(rows[0]?.openId, second, "应更新为新的 openId");
});

test("unbindQqAccount 解除绑定，且对未绑定的账号是幂等的", async () => {
  const openId = openIdFor("unbind");
  stubQq({ openId });
  const userId = await makeUser("unbind");

  await bindQqAccount(userId, config, "code");
  await unbindQqAccount(userId);
  assert.equal(await prisma.qqBinding.findUnique({ where: { userId } }), null);

  // 再解一次不该抛错（deleteMany 天然幂等）
  await assert.doesNotReject(() => unbindQqAccount(userId));
});
