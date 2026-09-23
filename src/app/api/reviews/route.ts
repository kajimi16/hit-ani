import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser, requireSessionUser } from "@/lib/auth/session";
import { isBlocked } from "@/lib/danmaku/filter";
import {
  ReviewKind,
  countReviews,
  createReview,
  listReviews,
  type ReviewKindValue,
} from "@/lib/review/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const listSchema = z.object({
  subjectId: z.coerce.number().int().positive(),
  kind: z.coerce.number().int().min(0).max(1).optional(),
  schoolOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true" || value === "1")),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * GET /api/reviews?subjectId=&kind=&schoolOnly=&limit=&offset=
 *
 * `schoolOnly` 的 schoolId 取自会话 —— 与弹幕同一套边界，客户端无法伪造。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  let query;
  try {
    query = listSchema.parse({
      subjectId: url.searchParams.get("subjectId"),
      kind: url.searchParams.get("kind") ?? undefined,
      schoolOnly: url.searchParams.get("schoolOnly") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "参数不合法", details: formatZod(error) },
      { status: 400 },
    );
  }

  const schoolOnly = query.schoolOnly ?? false;

  // 会话用户始终解析：`schoolTotal` 是常显的对照数据，不应只在开启筛选时才计算。
  const sessionUser = await getSessionUser();
  if (schoolOnly && !sessionUser) {
    return NextResponse.json({ error: "仅看本校评论需要登录" }, { status: 401 });
  }

  const [reviews, total, schoolTotal] = await Promise.all([
    listReviews({
      subjectId: query.subjectId,
      kind: query.kind as ReviewKindValue | undefined,
      schoolOnly,
      schoolId: sessionUser?.schoolId,
      limit: query.limit,
      offset: query.offset,
    }),
    countReviews(query.subjectId),
    sessionUser
      ? countReviews(query.subjectId, sessionUser.schoolId)
      : Promise.resolve(0),
  ]);

  return NextResponse.json({
    subjectId: query.subjectId,
    total,
    schoolTotal,
    schoolOnly,
    data: reviews,
  });
}

const createSchema = z.object({
  subjectId: z.number().int().positive(),
  kind: z.union([z.literal(ReviewKind.Short), z.literal(ReviewKind.Long)]),
  title: z.string().max(80).nullish(),
  content: z.string().min(1).max(8000),
  rating: z.number().int().min(1).max(10).nullish(),
});

/** POST /api/reviews */
export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: "参数不合法", details: formatZod(error) },
      { status: 400 },
    );
  }

  if (body.kind === ReviewKind.Long && !body.title) {
    return NextResponse.json({ error: "长评必须填写标题" }, { status: 400 });
  }

  // 评论/影评与弹幕同为校内 UGC，且**曝光面更大** —— 影评是长文，
  // 直接渲染在条目页上，比弹幕更容易被认真阅读和截图传播。
  // 标题也要查：只查正文会留下「标题里写违规内容」的口子。
  if (isBlocked(body.content) || (body.title && isBlocked(body.title))) {
    return NextResponse.json(
      { error: "内容包含被屏蔽的词，请修改后重试" },
      { status: 400 },
    );
  }

  const review = await createReview(user.id, {
    subjectId: body.subjectId,
    kind: body.kind,
    title: body.title ?? null,
    content: body.content.trim(),
    rating: body.rating ?? null,
  });

  return NextResponse.json({ data: review }, { status: 201 });
}

function formatZod(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
  }
  return error instanceof Error ? error.message : String(error);
}
