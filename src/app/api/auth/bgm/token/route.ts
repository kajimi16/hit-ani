import { NextResponse } from "next/server";
import { z } from "zod";
import { bindBgmPersonalToken } from "@/lib/auth/bgm-oauth";
import { requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  /** Bangumi 个人访问令牌。视为密码，不落日志、不回显。 */
  token: z.string().min(8).max(512),
});

/**
 * POST /api/auth/bgm/token — 用个人访问令牌绑定 Bangumi。
 *
 * 无需注册 OAuth 应用，适合校内自用部署。
 * 令牌先经 `GET /v0/me` 校验，无效直接 400，不会落库。
 */
export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = schema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error: "参数不合法",
        details:
          error instanceof z.ZodError
            ? error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
              }))
            : String(error),
      },
      { status: 400 },
    );
  }

  try {
    const { bgmUserId, username, expiresAt } = await bindBgmPersonalToken(
      user.id,
      body.token.trim(),
    );

    // 只回显非敏感字段；token 本身绝不出现在响应里
    return NextResponse.json({
      ok: true,
      bgmUserId,
      bgmUsername: username,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
