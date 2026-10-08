import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  reportId: z.string().min(1).max(64),
  /**
   * 处理结果。
   *
   * - `block`：屏蔽该弹幕（把 `Danmaku.status` 置为非 0）
   * - `dismiss`：驳回举报（弹幕保留）
   */
  action: z.enum(["block", "dismiss"]),
});

/**
 * GET /api/admin/reports — 待处理举报队列。
 *
 * ## 为什么这个端点必须存在
 *
 * 举报此前**只有写入没有读取**（`/api/danmaku/report` 只有 POST）——
 * 举报进去就没人能看到，功能形同虚设。学校部署方要能处理违规内容，
 * 这是合规刚需。
 */
export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  const statusParam = new URL(request.url).searchParams.get("status");
  // `0` 是待处理；不给参数时也默认待处理（后台首先关心这个）
  const status = statusParam === "all" ? undefined : Number(statusParam ?? 0);

  const reports = await prisma.danmakuReport.findMany({
    where: status === undefined || Number.isNaN(status) ? {} : { status },
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    take: 200,
    include: {
      // 举报人只需昵称；弹幕本体要连同发送者与所属条目
      reporter: { select: { nickname: true, email: true } },
      danmaku: {
        select: {
          id: true,
          text: true,
          status: true,
          playTimeMs: true,
          createdAt: true,
          user: { select: { nickname: true, email: true, schoolId: true } },
          episode: {
            select: {
              ep: true,
              sort: true,
              subject: { select: { id: true, name: true, nameCn: true } },
            },
          },
        },
      },
    },
  });

  const counts = await prisma.danmakuReport.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  return NextResponse.json({
    reports: reports.map((report) => ({
      id: report.id,
      reason: report.reason,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      handledAt: report.handledAt?.toISOString() ?? null,
      reporter: report.reporter.nickname,
      danmaku: {
        id: report.danmaku.id,
        text: report.danmaku.text,
        /** 非 0 表示已被屏蔽 —— 后台据此区分「已处理过」 */
        blocked: report.danmaku.status !== 0,
        playTimeMs: report.danmaku.playTimeMs,
        createdAt: report.danmaku.createdAt.toISOString(),
        author: report.danmaku.user.nickname,
        schoolId: report.danmaku.user.schoolId,
        subjectId: report.danmaku.episode.subject.id,
        subjectTitle: report.danmaku.episode.subject.nameCn || report.danmaku.episode.subject.name,
        episodeLabel: `第 ${report.danmaku.episode.ep ?? report.danmaku.episode.sort} 集`,
      },
    })),
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
  });
}

/**
 * PUT /api/admin/reports — 处理一条举报。
 *
 * ## 两个动作都会更新 `status`，但含义不同
 *
 * - `block`：`status = 1`（已屏蔽）**并且**把弹幕本体置为非正常状态。
 *   只改举报记录而不动弹幕，等于「标记为已处理但内容还在」—— 那是
 *   最容易被误当成修好的做法。
 * - `dismiss`：`status = 2`（已驳回），弹幕保留。
 *
 * 两者都写 `handledAt`，供事后审计「谁在什么时候处理的」。
 *
 * ## 为什么不做「删除弹幕」
 *
 * 屏蔽（`status != 0`）已经让它在所有读路径上不可见（弹幕查询都带
 * `status: 0`），而保留行能做两件事：**追溯**（同一用户反复违规时能看到
 * 历史）与**误判恢复**。物理删除是不可逆的，没必要。
 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ error: "需要管理员权限" }, { status: 403 });

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? (error.issues[0]?.message ?? "参数不合法") : "参数不合法" },
      { status: 400 },
    );
  }

  const report = await prisma.danmakuReport.findUnique({
    where: { id: body.reportId },
    select: { id: true, danmakuId: true, status: true },
  });
  if (!report) return NextResponse.json({ error: "举报不存在" }, { status: 404 });
  if (report.status !== 0) {
    return NextResponse.json({ error: "这条举报已经处理过了" }, { status: 409 });
  }

  const block = body.action === "block";

  /*
   * 用事务：举报状态与弹幕状态要么都改，要么都不改。
   * 只改一半会让「已屏蔽」的记录指向一条仍可见的弹幕 —— 后台显示已处理，
   * 而用户那边还能看到它。
   */
  await prisma.$transaction([
    prisma.danmakuReport.update({
      where: { id: report.id },
      data: { status: block ? 1 : 2, handledAt: new Date() },
    }),
    ...(block
      ? [prisma.danmaku.update({ where: { id: report.danmakuId }, data: { status: 1 } })]
      : []),
  ]);

  return NextResponse.json({ ok: true, action: body.action });
}
