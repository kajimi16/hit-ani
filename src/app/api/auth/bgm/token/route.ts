import { NextResponse } from "next/server";
import { z } from "zod";
import { bindBgmPersonalToken } from "@/lib/auth/bgm-oauth";
import { bindingErrorResponse } from "@/lib/auth/binding-response";
import { requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  /** Bangumi 个人访问令牌。视为密码，不落日志、不回显。 */
  token: z.string().min(8).max(512),
  /**
   * 该 Bangumi 账号已绑定到另一个本地账号时，是否迁移到当前账号。
   *
   * 默认 false：先回 409 让界面确认。令牌本身就是所有权的证明，
   * 所以迁移是安全的 —— 但**不能静默做**，否则与之关联的另一个账号会
   * 无声失去绑定。
   */
  takeOver: z.boolean().optional(),
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
      { takeOver: body.takeOver },
    );

    // 只回显非敏感字段；token 本身绝不出现在响应里
    return NextResponse.json({
      ok: true,
      bgmUserId,
      bgmUsername: username,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    // 冲突 → 409 + 机器可读的 code，界面据此弹「是否迁移」的确认。
    // 映射逻辑在 `@/lib/auth/binding-response`（无框架依赖，可直接单测）。
    const { status, body } = bindingErrorResponse(error);
    return NextResponse.json(body, { status });
  }
}
