import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import {
  followUser,
  listFollowers,
  listFollowing,
  searchUsers,
  unfollowUser,
} from "@/lib/friends/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  userId: z.string().min(1).max(64),
  action: z.union([z.literal("follow"), z.literal("unfollow")]),
});

/**
 * GET /api/friends — 好友页的全部数据。
 *
 * 一次返回三块（我关注的 / 关注我的 / 搜索结果），而不是三个端点：
 * 它们在同一屏渲染，分开请求只会多两次往返。
 * `q` 有值时带上搜索结果。
 */
export async function GET(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const keyword = new URL(request.url).searchParams.get("q") ?? "";

  const [following, followers, results] = await Promise.all([
    listFollowing(user.id),
    listFollowers(user.id),
    keyword.trim() ? searchUsers(user.id, keyword) : Promise.resolve([]),
  ]);

  return NextResponse.json({ following, followers, results });
}

/**
 * PUT /api/friends — 关注 / 取消关注。
 *
 * 用 PUT（不是 POST）且带 `action`：关注是**幂等**的（重复点不报错），
 * 取消未关注的人也算成功。这与 `/api/collections` 的既有取舍一致。
 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof z.ZodError ? "参数不合法" : String(error) },
      { status: 400 },
    );
  }

  try {
    if (body.action === "follow") {
      await followUser(user.id, body.userId);
    } else {
      await unfollowUser(user.id, body.userId);
    }
    return NextResponse.json({ ok: true, following: body.action === "follow" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}
