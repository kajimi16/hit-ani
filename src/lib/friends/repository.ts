/**
 * 关注关系（单向）。
 *
 * ## 为什么是单向而不是双向好友
 *
 * 双向好友需要「申请 → 对方同意」，而本平台**没有通知系统** —— 申请只能靠
 * 对方自己进好友页才发现，实际会被长期搁置。单向关注没有这个死角。
 *
 * ## 关注 ≠ 内容授权
 *
 * 关注只解除「你完全不认识这个人」的壁垒。`Collection.isPrivate` 为真的收藏
 * 仍然只有本人可见 —— 与时光机、收藏短评完全同一套规则。
 */

import { prisma } from "@/lib/prisma";

export interface UserSummary {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  schoolId: string;
  /** 公开收藏条数（不含私密）—— 让用户判断「值不值得关注」。 */
  publicCollectionCount: number;
  /** 我是否已关注他。 */
  following: boolean;
}

/**
 * 访问某人的追番列表时，是否要过滤掉私密收藏。
 *
 * **只有一条规则**：不是本人就过滤。抽成纯函数是因为这是隐私边界 ——
 * 写错不会有任何报错、界面看起来完全正常，只是别人的私密条目漏了出来。
 *
 * 返回的是**要不要加查询条件**，而不是逐行判定：过滤放在 `where` 里
 * （`isPrivate: false`）能走索引，也避免把私密行读进内存再丢掉。
 */
export function shouldHidePrivate(viewerId: string | null, ownerId: string): boolean {
  return viewerId !== ownerId;
}

/** 关注某人。自己关注自己直接拒绝（否则「我的好友」里会出现自己）。 */
export async function followUser(followerId: string, followeeId: string): Promise<void> {
  if (followerId === followeeId) throw new Error("不能关注自己");

  // 目标必须存在 —— 否则会留下指向空气的关注记录
  const target = await prisma.user.findUnique({ where: { id: followeeId }, select: { id: true } });
  if (!target) throw new Error("用户不存在");

  // upsert 而不是 create：重复点击不该报错（幂等）
  await prisma.userFollow.upsert({
    where: { followerId_followeeId: { followerId, followeeId } },
    create: { followerId, followeeId },
    update: {},
  });
}

/** 取消关注。未关注时静默成功（幂等）。 */
export async function unfollowUser(followerId: string, followeeId: string): Promise<void> {
  await prisma.userFollow.deleteMany({ where: { followerId, followeeId } });
}

/**
 * 按昵称/学号搜索用户。
 *
 * 排除自己 —— 搜到自己然后「加好友」是明显的死路。
 * 用 `contains` + `mode: "insensitive"`：昵称大小写不该影响匹配。
 */
export async function searchUsers(
  viewerId: string,
  keyword: string,
  limit = 20,
): Promise<UserSummary[]> {
  const trimmed = keyword.trim();
  if (trimmed.length === 0) return [];

  const users = await prisma.user.findMany({
    where: {
      id: { not: viewerId },
      OR: [
        { nickname: { contains: trimmed, mode: "insensitive" } },
        { studentNo: { contains: trimmed } },
      ],
    },
    take: Math.min(limit, 50),
    orderBy: { createdAt: "asc" },
    select: { id: true, nickname: true, avatarUrl: true, schoolId: true },
  });

  return withSummary(viewerId, users);
}

/** 我关注的人。 */
export async function listFollowing(viewerId: string): Promise<UserSummary[]> {
  const rows = await prisma.userFollow.findMany({
    where: { followerId: viewerId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      followee: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    },
  });
  return withSummary(viewerId, rows.map((row) => row.followee));
}

/** 关注我的人。 */
export async function listFollowers(viewerId: string): Promise<UserSummary[]> {
  const rows = await prisma.userFollow.findMany({
    where: { followeeId: viewerId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      follower: { select: { id: true, nickname: true, avatarUrl: true, schoolId: true } },
    },
  });
  return withSummary(viewerId, rows.map((row) => row.follower));
}

/**
 * 给一批用户补上「公开收藏数」与「我是否已关注」。
 *
 * 用两次 `groupBy`/`findMany` 批量取，而不是每个用户各查一次 ——
 * 好友页一屏可能有几十个人，逐个查就是几十次往返。
 */
async function withSummary(
  viewerId: string,
  users: { id: string; nickname: string; avatarUrl: string | null; schoolId: string }[],
): Promise<UserSummary[]> {
  if (users.length === 0) return [];
  const ids = users.map((user) => user.id);

  const [counts, following] = await Promise.all([
    prisma.collection.groupBy({
      by: ["userId"],
      where: { userId: { in: ids }, isPrivate: false },
      _count: { _all: true },
    }),
    prisma.userFollow.findMany({
      where: { followerId: viewerId, followeeId: { in: ids } },
      select: { followeeId: true },
    }),
  ]);

  const countByUser = new Map(counts.map((row) => [row.userId, row._count._all]));
  const followingSet = new Set(following.map((row) => row.followeeId));

  return users.map((user) => ({
    ...user,
    publicCollectionCount: countByUser.get(user.id) ?? 0,
    following: followingSet.has(user.id),
  }));
}

/** 取某个用户的公开资料（拼追番页头部用）。 */
export async function getUserProfile(
  viewerId: string | null,
  userId: string,
): Promise<(UserSummary & { isSelf: boolean }) | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, nickname: true, avatarUrl: true, schoolId: true },
  });
  if (!user) return null;

  const [summary] = await withSummary(viewerId ?? "", [user]);
  return {
    ...summary,
    isSelf: viewerId !== null && viewerId === user.id,
  };
}
