import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { bindBgmAccount, readBgmOAuthConfig } from "@/lib/auth/bgm-oauth";
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
    return NextResponse.json({ error: "缺少 code 或 state" }, { status: 400 });
  }

  const store = await cookies();
  const expected = store.get(OAUTH_STATE_COOKIE)?.value;
  store.delete(OAUTH_STATE_COOKIE);
  if (!expected || expected !== `bgm:${state}`) {
    return NextResponse.json({ error: "state 校验失败，请重新发起绑定" }, { status: 400 });
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
    return NextResponse.redirect(
      new URL(
        `/settings?bgm=failed&reason=${encodeURIComponent(
          error instanceof Error ? error.message : String(error),
        )}`,
        url.origin,
      ),
    );
  }
}
