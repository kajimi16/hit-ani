import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { randomBytes } from "node:crypto";
import { bgmAuthorizeUrl, readBgmOAuthConfig } from "@/lib/auth/bgm-oauth";
import { resolveSecureCookie } from "@/lib/auth/cookie-policy";
import { checkRedirectHost } from "@/lib/auth/redirect-host";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/bgm/start — 跳转 Bangumi 授权页。
 *
 * 授权域名是 `bgm.tv/oauth/authorize`（**不是** api.bgm.tv）。
 * `state` 存到 httpOnly Cookie，回调时比对照，防 CSRF。
 */
export async function GET(request: Request) {
  try {
    await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "请先登录后再绑定 Bangumi" }, { status: 401 });
  }

  const origin = new URL(request.url).origin;
  let config;
  try {
    config = readBgmOAuthConfig(origin);
  } catch {
    /*
     * 未配置 OAuth 应用 —— **跳回设置页并给出可操作的原因**，而不是返回裸 JSON。
     *
     * 用户是从设置页的链接进来的，直接给一页 `{"error":"缺少环境变量…"}`
     * 等于把他扔进死胡同。设置页有个人令牌这条等价路径，把他送回去。
     */
    return NextResponse.redirect(
      new URL(
        `/settings?bgm=failed&reason=${encodeURIComponent(
          "本部署未配置 Bangumi OAuth 应用（缺 BGM_CLIENT_ID / BGM_CLIENT_SECRET）。请改用「个人访问令牌」绑定，功能完全等价。",
        )}`,
        origin,
      ),
    );
  }

  /*
   * 先查「访问 host」与「登记的回调 host」是否一致 —— 见 `redirect-host.ts`。
   *
   * 不一致时 state Cookie 在回调请求里带不过去，校验必然失败。与其让用户去
   * bgm.tv 绕一圈再回来撞一个含糊的「状态校验失败」，不如当场说清。
   * 那个提示原先把原因归结为「停留太久 / Cookie 没保留」，完全没说到点子上。
   */
  const verdict = checkRedirectHost(origin, config.redirectUri);
  if (!verdict.ok) {
    return NextResponse.redirect(
      new URL(`/settings?bgm=failed&reason=${encodeURIComponent(verdict.message)}`, origin),
    );
  }

  const state = randomBytes(16).toString("base64url");
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, `bgm:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    // 与会话 Cookie 同一套判定（详见 cookie-policy.ts）
    secure: resolveSecureCookie(await headers()),
    path: "/",
    maxAge: 600,
  });

  /*
   * 用 `bgmAuthorizeUrl`（→ `buildAuthorizeUrl`）而不是在这里拼一遍。
   *
   * 这里原先硬编码了 `https://bgm.tv/oauth/authorize`，而权威实现用的是
   * `BGM_OAUTH_BASE` —— 两处会漂移（改环境变量只影响其中一处）。
   * 更糟的是 `bgmAuthorizeUrl` 这个 wrapper **从未被使用**，
   * 也就是说「被测过的那份」与「线上跑的那份」是两段代码。
   */
  return NextResponse.redirect(bgmAuthorizeUrl(config, state));
}
