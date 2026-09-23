import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  danmakuId: z.string().min(1).max(64),
  reason: z.string().min(1).max(200),
});

/**
 * POST /api/danmaku/report — 举报弹幕。
 *
 * 举报是弹幕作为 UGC 的必要配套：没有这个通道，违规内容没人能处理，
 * 风险最终落在部署方（学校）。
 *
 * 处理流程：举报落库为「待处理」，管理员在其后将其置为已屏蔽/已驳回。
 * 重复举报同一弹幕返回 409（唯一约束），不静默忽略 —— 让用户知道已经报过了。
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

  const danmaku = await prisma.danmaku.findUnique({
    where: { id: body.danmakuId },
    select: { id: true, userId: true },
  });
  if (!danmaku) {
    return NextResponse.json({ error: "弹幕不存在" }, { status: 404 });
  }

  if (danmaku.userId === user.id) {
    return NextResponse.json({ error: "不能举报自己发的弹幕" }, { status: 400 });
  }

  try {
    const report = await prisma.danmakuReport.create({
      data: {
        danmakuId: body.danmakuId,
        reporterId: user.id,
        reason: body.reason.trim(),
      },
      select: { id: true, createdAt: true },
    });
    return NextResponse.json({ ok: true, reportId: report.id }, { status: 201 });
  } catch (error) {
    // 唯一约束冲突 = 已经举报过
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return NextResponse.json({ error: "你已经举报过这条弹幕" }, { status: 409 });
    }
    throw error;
  }
}
