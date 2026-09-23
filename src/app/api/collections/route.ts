import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import { COLLECTION_STATUSES, statusLabel } from "@/lib/collection";
import { countByStatus, getCollectionStatus, setCollectionStatus } from "@/lib/collection-actions";
import { isBlocked } from "@/lib/danmaku/filter";
import type { CollectionStatusValue } from "@/lib/collection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statusValues = COLLECTION_STATUSES.map((meta) => meta.value) as [number, ...number[]];

const putSchema = z.object({
  subjectId: z.number().int().positive(),
  status: z.union(
    statusValues.map((value) => z.literal(value)) as [
      z.ZodLiteral<number>,
      ...z.ZodLiteral<number>[],
    ],
  ),
  rating: z.number().int().min(1).max(10).nullish(),
  comment: z.string().max(500).nullish(),
});

/**
 * GET /api/collections?subjectId=123
 *
 * 不传 `subjectId` 时返回五种状态的计数（看板用）；传了则返回该条目的当前状态。
 */
export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const raw = new URL(request.url).searchParams.get("subjectId");

  if (raw === null) {
    const counts = await countByStatus(user.id);
    return NextResponse.json({
      counts: COLLECTION_STATUSES.map((meta) => ({
        status: meta.value,
        label: meta.label,
        slug: meta.slug,
        count: counts[meta.value] ?? 0,
      })),
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    });
  }

  const subjectId = Number(raw);
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    return NextResponse.json({ error: "subjectId 不合法" }, { status: 400 });
  }

  const status = await getCollectionStatus(user.id, subjectId);
  return NextResponse.json({
    subjectId,
    status,
    statusLabel: status === null ? null : statusLabel(status),
  });
}

/**
 * PUT /api/collections — 设置条目收藏状态（五种之一）。
 *
 * 本地先写，再尽力镜像到 Bangumi；镜像失败不回滚，只在响应里标记 `bgmSynced: false`。
 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = putSchema.parse(await request.json());
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

  // 收藏短评会显示在追番看板与条目页上（`{comment.slice(0, 12)}`），
  // 与其他 UGC 一样需要过滤。
  if (body.comment && isBlocked(body.comment)) {
    return NextResponse.json({ error: "短评包含被屏蔽的词，请修改后重试" }, { status: 400 });
  }

  try {
    const result = await setCollectionStatus({
      userId: user.id,
      subjectId: body.subjectId,
      status: body.status as CollectionStatusValue,
      rating: body.rating ?? undefined,
      comment: body.comment ?? undefined,
      bgmBound: user.bgmBound,
      origin: new URL(request.url).origin,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
