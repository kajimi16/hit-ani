import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { bindQqAccount, readQqOAuthConfig } from "@/lib/auth/qq-oauth";
import { OAUTH_STATE_COOKIE, requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/auth/qq/callback?code=&state= */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.json({ error: "缺少 code 或 state" }, { status: 400 });
  }

  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);
  if (!expected || expected !== `qq:${state}`) {
    return NextResponse.json({ error: "state 校验失败，请重新发起绑定" }, { status: 400 });
  }

  let user;
  try {
    user = await requireSessionUser();
  } catch {
    return NextResponse.redirect(new URL("/login?next=/settings", url.origin));
  }

  try {
    const config = readQqOAuthConfig(url.origin);
    const { openId } = await bindQqAccount(user.id, config, code);
    return NextResponse.redirect(
      new URL(`/settings?qq=ok&openid=${encodeURIComponent(openId)}`, url.origin),
    );
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/settings?qq=failed&reason=${encodeURIComponent(
          error instanceof Error ? error.message : String(error),
        )}`,
        url.origin,
      ),
    );
  }
}
