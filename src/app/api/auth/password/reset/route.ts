import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { consumeCode, normalizeEmail, verifyCode, type VerifyOutcome } from "@/lib/email/verification";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^\d{6}$/, "验证码是 6 位数字"),
  /** 新口令。长度下限与注册一致（8），上限防超长串拖慢 scrypt。 */
  password: z.string().min(8).max(128),
});

/**
 * 验码失败的文案 —— 每条都要说清下一步做什么。
 *
 * `too-many-attempts` 尤其重要：不说「必须重新发送」，用户会在一个已作废的
 * 码上反复重试。（与注册共用同一套措辞，见 `VERIFY_MESSAGES` 的说明。）
 */
const VERIFY_MESSAGES: Record<Exclude<VerifyOutcome, "ok">, string> = {
  missing: "还没有向该邮箱发送重置验证码，请先点「发送验证码」。",
  expired: "验证码已过期，请重新发送。",
  invalid: "验证码不正确。",
  "too-many-attempts": "验证码错误次数过多，已作废，请重新发送。",
};

/**
 * POST /api/auth/password/reset — 用邮箱验证码重置口令。
 *
 * ## 为什么必须有这个功能
 *
 * 此前**没有任何找回口令的入口**：学生忘了口令 = 永久失去账号，只能找
 * 管理员改库。而登录是本站的唯一身份入口，这条路的断点代价很高。
 *
 * ## 复用注册那套验证码设施，但**用途隔离**
 *
 * `EmailVerification` 的主键是 `(email, purpose)`，重置码的 `purpose` 是
 * `"reset"` —— 因此**注册码不能用来重置别人的密码**。
 *
 * ## 不泄露账号是否存在
 *
 * 这个接口只对**已发出的重置码**负责：邮箱不存在时 `verifyCode` 返回
 * `missing`，与「没发过码」不可区分。探测面在发码接口那侧（那里的取舍
 * 已在 `send-code/route.ts` 写明，是有意为之）。
 */
export async function POST(request: Request) {
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

  const email = normalizeEmail(body.email);

  // 用途必须是 reset —— 传 register 的码在这里验不过
  const outcome = await verifyCode(email, body.code, "reset");
  if (outcome !== "ok") {
    // 403 而不是 400：不是参数格式错，而是凭据不成立
    return NextResponse.json({ error: VERIFY_MESSAGES[outcome] }, { status: 403 });
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    // 码验过了却没有账号 —— 只可能是账号在这期间被删。仍然作废这个码。
    await consumeCode(email, "reset");
    return NextResponse.json({ error: "该邮箱还没有注册过。" }, { status: 404 });
  }

  await prisma.user.update({
    where: { id: user.id },
    // 与注册同一条散列路径（scrypt），不另写一套
    data: { passwordHash: await hashPassword(body.password) },
  });

  // 一次性：用掉即删，不能拿去改第二次
  await consumeCode(email, "reset");

  /*
   * 口令已重置但不自动登录 —— 让用户用**新口令**走一次登录。
   *
   * 自动登录会让「重置」与「登录」两条路径的成功条件混在一起：万一重置
   * 写库成功而会话签发有问题，用户会以为重置失败又去重置一次。
   */
  return NextResponse.json({ ok: true });
}
