import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { hostHeadersFrom, resolvePublicOrigin } from "@/lib/auth/request-origin";
import { readQqOAuthConfig, qqAuthorizeUrl } from "@/lib/auth/qq-oauth";
import { resolveSecureCookie } from "@/lib/auth/cookie-policy";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/qq/start — 跳转 QQ 互联授权页。 */
export async function GET(request: Request) {
  try {
    await requireSessionUser();
  } catch {
    // 未登录：与 BGM 的 start 一致 —— 这是**接口语义**（401），
    // 而不是用户从页面点进来的路径（那种情况下前端本就不会渲染按钮）。
    return NextResponse.json({ error: "请先登录后再绑定 QQ" }, { status: 401 });
  }

  // 与 BGM 的 start 同一处：优先 APP_BASE_URL，其次请求头 —— 见 request-origin.ts
  const requestHeaders = await headers();
  const origin = resolvePublicOrigin(
    hostHeadersFrom(requestHeaders),
    new URL(request.url).origin,
  ).origin;
  let config;
  try {
    config = readQqOAuthConfig(origin);
  } catch {
    /*
     * 未配置 QQ 互联应用 —— **跳回设置页并给出可操作的原因**，而不是裸 JSON。
     *
     * 与 BGM 的 start 同一取舍（那边已改）：用户是从设置页的链接进来的，
     * 一页 `{"error":"缺少环境变量…"}` 等于把他扔进死胡同，界面上也没法
     * 附上「该怎么办」。QQ 这条路没有等价替代方案，因此说明去哪里申请。
     */
    return NextResponse.redirect(
      new URL(
        `/settings?qq=failed&reason=${encodeURIComponent(
          "本部署未配置 QQ 互联应用（缺 QQ_APP_ID / QQ_APP_KEY）。请到 https://connect.qq.com 创建应用并填入 .env。",
        )}`,
        origin,
      ),
    );
  }

  const state = randomBytes(16).toString("base64url");
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, `qq:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    // 与会话 Cookie 同一套判定（详见 cookie-policy.ts）
    secure: resolveSecureCookie(requestHeaders),
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(qqAuthorizeUrl(config, state));
}
