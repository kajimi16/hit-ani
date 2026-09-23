import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { UnauthorizedError, getSessionUser, requireSessionUser } from "@/lib/auth/session";
import { validateSendInput } from "@/lib/danmaku/engine";
import { isBlocked } from "@/lib/danmaku/filter";
import { danmakuRateLimiter } from "@/lib/danmaku/rate-limit";
import { countDanmaku, createDanmaku, listDanmaku } from "@/lib/danmaku/repository";
import { danmakuQuerySchema, danmakuSendSchema } from "@/lib/danmaku/schema";
import type { DanmakuQuery } from "@/lib/danmaku/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/danmaku?episodeId=&fromMs=&toMs=&schoolOnly=
 *
 * `schoolOnly` 只在校内语义下有意义 —— `schoolId` 一律取自会话，
 * 不接受客户端传参，避免被伪造成「任意学校」。
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  let query;
  try {
    query = danmakuQuerySchema.parse({
      episodeId: url.searchParams.get("episodeId"),
      fromMs: url.searchParams.get("fromMs") ?? undefined,
      toMs: url.searchParams.get("toMs") ?? undefined,
      schoolOnly: url.searchParams.get("schoolOnly") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "参数不合法", details: formatZodError(error) },
      { status: 400 },
    );
  }

  const schoolOnly = query.schoolOnly ?? false;

  // 会话用户始终解析：`schoolTotal` 是常显的对照数据，不应只在开启筛选时才计算。
  const sessionUser = await getSessionUser();
  if (schoolOnly && !sessionUser) {
    return NextResponse.json({ error: "仅看本校弹幕需要登录" }, { status: 401 });
  }

  const effectiveQuery: DanmakuQuery = {
    episodeId: query.episodeId,
    fromMs: query.fromMs,
    toMs: query.toMs,
    limit: query.limit,
    schoolOnly,
    schoolId: sessionUser?.schoolId,
  };

  const [danmakus, total, schoolTotal] = await Promise.all([
    listDanmaku(effectiveQuery),
    countDanmaku(query.episodeId),
    sessionUser
      ? countDanmaku(query.episodeId, sessionUser.schoolId)
      : Promise.resolve(0),
  ]);

  return NextResponse.json({
    episodeId: query.episodeId,
    total,
    schoolTotal,
    returned: danmakus.length,
    schoolOnly,
    data: danmakus,
  });
}

/**
 * POST /api/danmaku
 * body: { episodeId, playTimeMs, text, color?, location? }
 *
 * `schoolId` 与 `userId` 均从会话解析 —— 客户端无法伪造本校身份。
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: "请先登录" }, { status: 401 });
    }
    throw error;
  }

  let body;
  try {
    body = danmakuSendSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: "参数不合法", details: formatZodError(error) },
      { status: 400 },
    );
  }

  const errors = validateSendInput(body);
  if (errors.length > 0) {
    return NextResponse.json({ error: "参数不合法", details: errors }, { status: 400 });
  }

  // 服务端屏蔽词：违规内容不能因为用户没设本地过滤就进所有人的屏幕。
  // 不告知具体命中哪个词 —— 那等于给出绕过词表的方法。
  if (isBlocked(body.text)) {
    return NextResponse.json(
      { error: "弹幕包含被屏蔽的内容，请修改后重试" },
      { status: 400 },
    );
  }

  const decision = danmakuRateLimiter.consume(user.id);
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "发送过于频繁，请稍后再试" },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
      },
    );
  }

  const { danmaku } = await createDanmaku(user.id, body);
  return NextResponse.json({ data: danmaku }, { status: 201 });
}

function formatZodError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
  }
  return error instanceof Error ? error.message : String(error);
}
