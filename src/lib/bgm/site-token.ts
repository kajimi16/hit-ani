/**
 * 站级 Bangumi 令牌 —— 只用于「需要可见性」的读取。
 *
 * ## 为什么需要它
 *
 * BGM 对 NSFW 资源的可见性取决于**请求所用账号**：
 * 已登录且注册满 60 天才能看到（见 `bangumi/server/internal/auth/domain.go`
 * 的 `AllowNSFW`），否则 NSFW 条目直接 404、搜索过滤被静默忽略。
 *
 * 条目详情是**全局缓存**（一份数据给所有人看），因此不能借「当前请求的用户」
 * 去拉：那会把某个用户的可见权限写进共享缓存，再呈现给没有权限的人。
 * 必须用一个固定的、站级的令牌。
 *
 * ## 凭据从哪来
 *
 * 复用**管理员的 Bangumi 绑定** —— 不额外增加一份需要人工轮换的密钥。
 * 代价也明确：管理员解绑后这里会返回 `null`，届时退化为匿名读取
 * （已写入的 `nsfw` 标记保留，不会因此丢失）。
 *
 * ## 拿不到就返回 null，调用方按匿名处理
 *
 * 不抛错：这个令牌只用于「锦上添花」的 NSFW 判定，拿不到不该让整个页面
 * 或导入流程失败。
 */

import { getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { prisma } from "@/lib/prisma";

/**
 * 取一个管理员绑定的 Bangumi 令牌。
 *
 * `origin` 仅在需要刷新 OAuth 令牌时才用得上（个人令牌不走刷新流程）。
 */
export async function getSiteBgmToken(origin = ""): Promise<string | null> {
  const binding = await prisma.bgmBinding.findFirst({
    where: { user: { isAdmin: true } },
    select: { userId: true },
    // 多个管理员时固定取最早绑定的那个，避免结果随查询顺序漂移
    orderBy: { userId: "asc" },
  });
  if (!binding) return null;

  try {
    const { accessToken } = await getFreshBgmAccessToken(binding.userId, origin);
    return accessToken;
  } catch {
    // 令牌过期/刷新失败：降级为匿名读取，不阻断主流程
    return null;
  }
}
