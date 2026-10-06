import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  BgmAccountTakenError,
  bindBgmAccount,
  readBgmOAuthConfig,
} from "@/lib/auth/bgm-oauth";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/bgm/callback?code=&state=
 *
 * 注意：BGM 的 `code` 有效期只有 60 秒，收到后必须立刻换取 token（本函数内完成）。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      new URL(`/settings?bgm=denied&reason=${encodeURIComponent(oauthError)}`, url.origin),
    );
  }
  if (!code || !state) {
    // 跳回设置页给可操作的原因，而不是裸 JSON —— 用户是被 BGM 重定向过来的，
    // 一个 JSON 报错页没有出路（与 start 路由同一取舍）。
    return NextResponse.redirect(
      new URL(
        `/settings?bgm=failed&reason=${encodeURIComponent("Bangumi 未返回授权码（code / state 缺失）。请重新发起绑定。")}`,
        url.origin,
      ),
    );
  }

  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);
  if (!expected || expected !== `bgm:${state}`) {
    /*
     * state 校验失败最常见的原因是 **Cookie 没带回来**，而不一定是攻击：
     * - 用户在不同域名/IP 之间跳转（`redirect_uri` 指向另一个 host）；
     * - Cookie 带了 `Secure` 而实际是 HTTP（本项目踩过，见 cookie-policy.ts）；
     * - 授权页停留超过 10 分钟，state Cookie 已过期。
     * 因此提示里把这几种可能都说清楚，而不是只说「校验失败」。
     */
    return NextResponse.redirect(
      new URL(
        `/settings?bgm=failed&reason=${encodeURIComponent(
          "授权状态校验失败（state 不匹配或已过期）。常见原因：授权页停留超过 10 分钟、或浏览器未保留 Cookie。请重新发起绑定。",
        )}`,
        url.origin,
      ),
    );
  }

  let user;
  try {
    user = await requireSessionUser();
  } catch {
    return NextResponse.redirect(new URL("/login?next=/settings", url.origin));
  }

  try {
    const config = readBgmOAuthConfig(url.origin);
    const { bgmUserId } = await bindBgmAccount(user.id, config, code);
    return NextResponse.redirect(
      new URL(`/settings?bgm=ok&uid=${bgmUserId}`, url.origin),
    );
  } catch (error) {
    /*
     * 冲突单独标出来，让设置页显示「已绑定到另一个账号」而不是一句含糊的失败。
     * 这里**不**自动迁移 —— 跳转回来的路径上没法让用户确认，而静默解除另一
     * 账号的绑定不可接受（见 `saveBinding`）。迁移入口在设置页的「个人访问
     * 令牌」那一路，那里能弹确认。
     */
    const taken = error instanceof BgmAccountTakenError;
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(
      new URL(
        `/settings?bgm=${taken ? "taken" : "failed"}&reason=${encodeURIComponent(reason)}`,
        url.origin,
      ),
    );
  }
}
