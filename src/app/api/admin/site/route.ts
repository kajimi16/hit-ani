import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { getSiteNsfwEnabled, setSiteNsfwEnabled } from "@/lib/site-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** 站点是否允许显示 NSFW（R18）内容。 */
  nsfwEnabled: z.boolean(),
});

/**
 * 网站管理的站点级设置。
 *
 * ## 为什么读也要走接口
 *
 * 管理页是服务端组件，首屏已经拿到值了。但管理员切换后需要**重新读一次**
 * 权威状态（而不是拿本地 state 当真）—— 写入可能失败、也可能被另一个
 * 管理员标签页改掉。GET 让「界面显示的值」始终来自库。
 *
 * ## 为什么写要单独一个接口而不是复用 `/api/settings/mirror`
 *
 * 那个是**用户级**设置（BGM 同步开关）。这里是**站点级**、需要管理员权限、
 * 影响所有用户 —— 混在一起会让权限判断变成「看字段决定」，很容易漏。
 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  return NextResponse.json({ nsfwEnabled: await getSiteNsfwEnabled() });
}

export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  let body;
  try {
    body = bodySchema.parse(await request.json());
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

  await setSiteNsfwEnabled(body.nsfwEnabled, user.id);
  return NextResponse.json({ ok: true, nsfwEnabled: body.nsfwEnabled });
}
