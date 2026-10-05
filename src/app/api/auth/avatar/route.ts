import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchBgmIdentity, getFreshBgmAccessToken } from "@/lib/auth/bgm-oauth";
import { requireSessionUser } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 头像地址的约束。
 *
 * **只允许 https 的图片直链**，且不接受 `data:` / `javascript:` 等协议 ——
 * 这个值会被 `next/image` 直接拿去请求，也会出现在别人的评论列表里。
 * 允许任意协议等于把服务端变成一个任意 URL 的请求发起器。
 *
 * 长度上限 512：够长到容纳带参数的头像 CDN 地址，又不至于被拿来塞东西。
 */
const avatarUrlSchema = z
  .string()
  .trim()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }, "头像地址必须是以 https:// 开头的完整链接");

const schema = z.union([
  /** 用 BGM 绑定账号的头像（同一次 `/v0/me` 请求里就有，不额外发请求）。 */
  z.object({ action: z.literal("import-bgm") }),
  /** 自定义头像地址。 */
  z.object({ action: z.literal("set"), url: avatarUrlSchema }),
  /** 恢复成默认（首字母占位）。 */
  z.object({ action: z.literal("clear") }),
]);

/**
 * POST /api/auth/avatar — 设置 / 导入 / 清除头像。
 *
 * 三种来源都收敛到这里，而不是各开一个端点：它们写的是同一列，
 * 分开写迟早会出现「一个端点校验了 https、另一个没校验」。
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
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? "参数不合法")
            : "参数不合法",
      },
      { status: 400 },
    );
  }

  if (body.action === "clear") {
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
    return NextResponse.json({ ok: true, avatarUrl: null });
  }

  if (body.action === "set") {
    await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: body.url } });
    return NextResponse.json({ ok: true, avatarUrl: body.url });
  }

  // import-bgm
  let token: string | undefined;
  try {
    // 需要 origin 才能在令牌临近过期时刷新（`readBgmOAuthConfig` 要它拼 redirectUri）
    ({ accessToken: token } = await getFreshBgmAccessToken(user.id, new URL(request.url).origin));
  } catch {
    token = undefined;
  }
  if (!token) {
    return NextResponse.json(
      { error: "尚未绑定 Bangumi，或令牌已失效。请先在下方重新绑定。" },
      { status: 400 },
    );
  }

  let avatar: { large: string; medium: string; small: string } | null = null;
  try {
    avatar = (await fetchBgmIdentity(token)).avatar;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取 Bangumi 头像失败" },
      { status: 400 },
    );
  }

  if (!avatar) {
    return NextResponse.json(
      { error: "该 Bangumi 账号没有可用头像（它可能用的是默认头像）。" },
      { status: 400 },
    );
  }

  // 存 medium：列表里显示尺寸约 32–48px，medium 在 2x 屏上也够清晰，
  // 而 large 往往是几百 KB —— 会被每个看到这条评论的人请求一次。
  await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: avatar.medium } });
  return NextResponse.json({ ok: true, avatarUrl: avatar.medium });
}
