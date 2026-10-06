import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  /** 是否把站内操作同步写回 Bangumi。 */
  mirrorToBgm: z.boolean(),
});

/** GET /api/settings/mirror — 读取当前同步偏好。 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  return NextResponse.json({
    mirrorToBgm: user.mirrorToBgm,
    /** 是否绑定了 BGM —— 未绑定时开关应禁用。 */
    bgmBound: user.bgmBound,
    /** 运维是否用硬闸关掉了全部镜像（此时用户开关无效）。 */
    opsDisabled: process.env.BGM_MIRROR_ENABLED === "0",
  });
}

/**
 * PUT /api/settings/mirror — 修改同步偏好。
 *
 * ## 关于「运维硬闸」
 *
 * `BGM_MIRROR_ENABLED=0` 是**运维级**开关（跑写库测试时用），它压过用户偏好。
 * 这里**不阻止**用户保存 `mirrorToBgm: true` —— 硬闸随时可能被运维重新打开，
 * 用户的选择应当被记住。界面只提示「当前被管理员临时关闭」，而不是把
 * 用户的开关改掉。
 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = schema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? "参数不合法" : String(error) },
      { status: 400 },
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mirrorToBgm: body.mirrorToBgm },
  });

  return NextResponse.json({
    ok: true,
    mirrorToBgm: body.mirrorToBgm,
    opsDisabled: process.env.BGM_MIRROR_ENABLED === "0",
  });
}
