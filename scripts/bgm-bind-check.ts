/**
 * Bangumi 绑定落库验证 —— 用桩替换上游 API，验证「绑定成功」确实写进了数据库。
 *
 * 为什么需要这个脚本：绑定流程有两步不可见的副作用（校验 `/v0/me`、写 `BgmBinding`），
 * 一旦中间被改坏，UI 会显示"绑定成功"但库里没有记录，用户紧接着点导入必然报
 * "尚未绑定" —— 这类"假成功"用类型检查或纯逻辑单测都抓不到。
 *
 * 覆盖：
 *  1. 个人令牌绑定 → 数据库确有记录，且 `personalToken = true`
 *  2. 绑定后 `getFreshBgmAccessToken` 能取回令牌（= 导入/进度回写可用）
 *  3. 无效令牌 → 抛错且**不落库**
 *  4. 重复绑定 → 覆盖而非新增（幂等）
 *  5. 个人令牌过期 → 抛 `BgmTokenExpiredError`，不回落到 OAuth 刷新
 *
 * 运行：`npm run bgm:bind-check`（需要 DATABASE_URL 指向可写的库）
 */

import { prisma } from "@/lib/prisma";
import {
  BgmNotBoundError,
  BgmTokenExpiredError,
  bindBgmPersonalToken,
  getFreshBgmAccessToken,
  unbindBgmAccount,
} from "@/lib/auth/bgm-oauth";
import { hashPassword } from "@/lib/auth/password";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✘ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

const REAL_FETCH = globalThis.fetch;

interface StubOptions {
  /** `/v0/me` 的响应；null 表示 401 */
  me?: { id: number; username: string } | null;
  /** `/oauth/token_status` 的响应；null 表示不支持 */
  tokenStatus?: { expires: number } | null;
}

/** 只拦截 bgm.tv / api.bgm.tv，其余请求透传（避免影响 Prisma 等）。 */
function stubBgmApi(options: StubOptions): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url.includes("api.bgm.tv/v0/me")) {
      if (!options.me) {
        return new Response(JSON.stringify({ title: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(options.me), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/oauth/token_status")) {
      if (!options.tokenStatus) {
        return new Response("bad request", { status: 400 });
      }
      return new Response(JSON.stringify(options.tokenStatus), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`未预期的上游请求: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  console.log("=== Bangumi 绑定落库验证（上游已打桩）===\n");

  const email = `bindcheck-${Date.now()}@hit.edu.cn`;
  const user = await prisma.user.create({
    data: {
      email,
      nickname: "绑定验证",
      passwordHash: await hashPassword("bindcheck-password"),
      schoolId: "hit",
    },
    select: { id: true },
  });

  try {
    // ------------------------------------------------------------ 未绑定
    console.log("1. 未绑定时取令牌");
    try {
      await getFreshBgmAccessToken(user.id, "http://localhost:3100");
      check("未绑定应抛错", false);
    } catch (error) {
      check("抛 BgmNotBoundError", error instanceof BgmNotBoundError, String(error));
    }

    // ------------------------------------------------------------ 无效令牌
    console.log("\n2. 无效令牌不得落库");
    stubBgmApi({ me: null });
    try {
      await bindBgmPersonalToken(user.id, "definitely-invalid-token");
      check("无效令牌应抛错", false);
    } catch (error) {
      check("抛错且信息可读", /无效或已过期/.test(String(error)), String(error));
    }
    check(
      "库中仍然没有绑定记录（未产生脏数据）",
      (await prisma.bgmBinding.count({ where: { userId: user.id } })) === 0,
    );

    // ------------------------------------------------------------ 有效令牌
    console.log("\n3. 有效令牌绑定并落库");
    const futureExpiry = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    stubBgmApi({
      me: { id: 987654, username: "bindcheck_user" },
      tokenStatus: { expires: futureExpiry },
    });

    const bound = await bindBgmPersonalToken(user.id, "valid-personal-token-abc123");
    check("返回值含 bgmUserId", bound.bgmUserId === 987654, bound);
    check("返回值含 username", bound.username === "bindcheck_user", bound);

    // ★ 这一条正是 advisory 担心的：UI 说成功，库里必须有行
    const row = await prisma.bgmBinding.findUnique({ where: { userId: user.id } });
    check("数据库中确实存在绑定记录", row !== null);
    check("personalToken 标记为 true", row?.personalToken === true, row?.personalToken);
    check("用户名已落库", row?.bgmUsername === "bindcheck_user", row?.bgmUsername);
    check("令牌已落库", row?.accessToken === "valid-personal-token-abc123");
    check("refreshToken 为空串（个人令牌无刷新）", row?.refreshToken === "");
    check(
      "到期时间取自 token_status",
      row?.expiresAt !== undefined &&
        Math.abs(row.expiresAt.getTime() - futureExpiry * 1000) < 1000,
      row?.expiresAt,
    );

    // ------------------------------------------------------------ 绑定后可用
    console.log("\n4. 绑定后可取回令牌（导入与进度回写的前提）");
    const fresh = await getFreshBgmAccessToken(user.id, "http://localhost:3100");
    check("取回 accessToken", fresh.accessToken === "valid-personal-token-abc123", fresh);
    check("取回 bgmUsername", fresh.bgmUsername === "bindcheck_user");

    // ------------------------------------------------------------ 幂等
    console.log("\n5. 重复绑定应覆盖而非报错");
    stubBgmApi({
      me: { id: 987654, username: "bindcheck_user_renamed" },
      tokenStatus: { expires: futureExpiry },
    });
    await bindBgmPersonalToken(user.id, "second-personal-token-xyz789");
    const rows = await prisma.bgmBinding.findMany({ where: { userId: user.id } });
    check("仍只有一条记录", rows.length === 1, rows.length);
    check("令牌已被覆盖", rows[0]?.accessToken === "second-personal-token-xyz789");
    check("用户名已被覆盖", rows[0]?.bgmUsername === "bindcheck_user_renamed");

    // ------------------------------------------------------------ 过期
    console.log("\n6. 个人令牌过期应明确报错，不回落到 OAuth 刷新");
    await prisma.bgmBinding.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    try {
      await getFreshBgmAccessToken(user.id, "http://localhost:3100");
      check("过期应抛错", false);
    } catch (error) {
      check("抛 BgmTokenExpiredError", error instanceof BgmTokenExpiredError, String(error));
      check("提示用户重新生成", /重新生成/.test(String(error)), String(error));
    }

    // ------------------------------------------------------------ 解绑
    console.log("\n7. 解绑");
    await unbindBgmAccount(user.id);
    check(
      "解绑后记录已删除",
      (await prisma.bgmBinding.count({ where: { userId: user.id } })) === 0,
    );
  } finally {
    globalThis.fetch = REAL_FETCH;
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log(`\n通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("✔ 全部通过（绑定确实落库、幂等、过期可诊断）");
  }
}

main()
  .catch((error) => {
    globalThis.fetch = REAL_FETCH;
    console.error("验证异常终止：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
