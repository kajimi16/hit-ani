import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { readQqOAuthConfig, qqAuthorizeUrl } from "@/lib/auth/qq-oauth";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/qq/start — 跳转 QQ 互联授权页。 */
export async function GET(request: Request) {
  try {
    await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "请先登录后再绑定 QQ" }, { status: 401 });
  }

  const origin = new URL(request.url).origin;
  let config;
  try {
    config = readQqOAuthConfig(origin);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }

  const state = randomBytes(16).toString("base64url");
  const store = await cookies();
  store.set(OAUTH_STATE_COOKIE, `qq:${state}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });

  return NextResponse.redirect(qqAuthorizeUrl(config, state));
}
