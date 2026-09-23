import { NextResponse } from "next/server";
import {
  BgmNotBoundError,
  BgmTokenExpiredError,
  getFreshBgmAccessToken,
  unbindBgmAccount,
} from "@/lib/auth/bgm-oauth";
import { unbindQqAccount } from "@/lib/auth/qq-oauth";
import { requireSessionUser } from "@/lib/auth/session";
import { importUserLibrary } from "@/lib/bgm/import";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** 大收藏量的账号需要拉取多页，放宽时限。 */
export const maxDuration = 300;

/**
 * POST /api/library/import — 一键导入 Bangumi 收藏。
 *
 * **一次请求完成**：导入只写「轻量数据」（条目骨架 + 收藏关系），
 * 数据全部来自收藏列表接口内嵌的 `SlimSubject`，因此请求量只有
 * `⌈收藏数 / 100⌉ + 1` 次 —— 377 个收藏只需 4 次。
 *
 * 完整详情（简介 / 章节 / 单集进度）留到用户真正打开某个条目时
 * 由 `enrichSubject` 补齐，见 `src/lib/bgm/import.ts`。
 *
 * 早先的实现逐条拉详情，377 个收藏要上千次请求、447 秒，
 * 因此才需要「快照 + 游标」的批处理机制。现在那个复杂度不再必要。
 */
export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const binding = await prisma.bgmBinding.findUnique({
    where: { userId: user.id },
    select: { bgmUsername: true },
  });
  if (!binding) {
    return NextResponse.json({ error: "尚未绑定 Bangumi 账号" }, { status: 409 });
  }

  let accessToken: string;
  let bgmUsername: string;
  try {
    ({ accessToken, bgmUsername } = await getFreshBgmAccessToken(
      user.id,
      new URL(request.url).origin,
    ));
  } catch (error) {
    if (error instanceof BgmTokenExpiredError || error instanceof BgmNotBoundError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  try {
    const stats = await importUserLibrary(user.id, { username: bgmUsername, accessToken });
    return NextResponse.json({ ok: true, bgmUsername, stats });
  } catch (error) {
    return NextResponse.json(
      {
        error: "导入失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

/** GET /api/library/import — 上次同步时间与规模，供设置页展示。 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const [binding, collectionCount, subjectCount] = await Promise.all([
    prisma.bgmBinding.findUnique({
      where: { userId: user.id },
      select: { syncedAt: true, bgmUsername: true },
    }),
    prisma.collection.count({ where: { userId: user.id } }),
    prisma.subject.count(),
  ]);

  return NextResponse.json({
    bound: binding !== null,
    bgmUsername: binding?.bgmUsername ?? null,
    syncedAt: binding?.syncedAt?.toISOString() ?? null,
    collectionCount,
    /** 本地缓存的条目总数（所有用户共享） */
    subjectCount,
  });
}

/** DELETE /api/library/import?target=bgm|qq — 解除绑定。 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const target = new URL(request.url).searchParams.get("target");
  if (target === "bgm") {
    await unbindBgmAccount(user.id);
    return NextResponse.json({ ok: true, target });
  }
  if (target === "qq") {
    await unbindQqAccount(user.id);
    return NextResponse.json({ ok: true, target });
  }
  return NextResponse.json({ error: "target 只能是 bgm 或 qq" }, { status: 400 });
}
