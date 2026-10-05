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
