import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { QqAccountTakenError, bindQqAccount, readQqOAuthConfig } from "@/lib/auth/qq-oauth";
import { hostHeadersFrom, resolvePublicOrigin } from "@/lib/auth/request-origin";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/qq/callback?code=&state= */
export async function GET(request: Request) {
  const url = new URL(request.url);
  /*
   * 与 BGM 回调同一处坑：`url.origin` 是服务器自己的监听地址（实测无视
   * `Host` 头），用它拼 Location 会把用户送到他自己那台机器。
   */
  const origin = resolvePublicOrigin(hostHeadersFrom(await headers()), url.origin).origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    /*
     * 跳回设置页给可操作的原因，而不是裸 JSON —— 与 BGM 回调同一取舍。
     * 用户是被 QQ 重定向过来的，一页 JSON 报错没有出路。
     */
    return NextResponse.redirect(
      new URL(
        `/settings?qq=failed&reason=${encodeURIComponent("QQ 未返回授权码（code / state 缺失）。请重新发起绑定。")}`,
        origin,
      ),
    );
  }

  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);
  if (!expected || expected !== `qq:${state}`) {
    /*
     * 与 BGM 回调同一段说明：state 失败最常见的原因是 **Cookie 没带回来**，
     * 而不一定是攻击（停留超时、Cookie 未保留、跨主机跳转）。
     * 把可能原因说清楚，用户才知道下一步做什么。
     */
    return NextResponse.redirect(
      new URL(
        `/settings?qq=failed&reason=${encodeURIComponent(
          "授权状态校验失败（state 不匹配或已过期）。常见原因：授权页停留超过 10 分钟、或浏览器未保留 Cookie。请重新发起绑定。",
        )}`,
        origin,
      ),
    );
  }

  let user;
  try {
    user = await requireSessionUser();
  } catch {
    return NextResponse.redirect(new URL("/login?next=/settings", origin));
  }

  try {
    const config = readQqOAuthConfig(origin);
    const { openId } = await bindQqAccount(user.id, config, code);
    return NextResponse.redirect(
      new URL(`/settings?qq=ok&openid=${encodeURIComponent(openId)}`, origin),
    );
  } catch (error) {
    // 冲突单独标出来，设置页才能显示「已被另一个账号绑定」而不是含糊的失败
    const taken = error instanceof QqAccountTakenError;
    const reason = error instanceof Error ? error.message : String(error);
    return NextResponse.redirect(
      new URL(
        `/settings?qq=${taken ? "taken" : "failed"}&reason=${encodeURIComponent(reason)}`,
        origin,
      ),
    );
  }
}
