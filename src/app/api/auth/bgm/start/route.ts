import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { readBgmOAuthConfig } from "@/lib/auth/bgm-oauth";
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
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString("base64url");
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, `bgm:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  const url = new URL("https://bgm.tv/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
