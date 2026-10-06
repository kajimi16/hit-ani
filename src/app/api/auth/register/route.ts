import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { SchoolAdmissionError, normalizeStudentNo, resolveSchoolByEmail } from "@/lib/auth/school";
import { isBlocked } from "@/lib/danmaku/filter";
import { getSessionUser, setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";
import { announceCapabilities, checkCapabilities } from "@/lib/email/capabilities";
import { consumeCode, verifyCode, type VerifyOutcome } from "@/lib/email/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register
 * body: { email, password, nickname, studentNo? }
 *
 * 学校由邮箱域名解析 —— 不接受客户端传 schoolId。
 */
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  nickname: z.string().min(1).max(24),
  studentNo: z.string().max(32).optional(),
  /**
   * 邮箱验证码。**强制**（用户明确要求）—— 见 `@/lib/email/verification`。
   *
   * 没有它，任何人都能用**别人的**校内邮箱注册，而平台无法证明邮箱归属；
   * 后续「找回密码」「校内身份」都建立在这个验证之上。
   */
  verificationCode: z.string().regex(/^\d{6}$/, "验证码是 6 位数字"),
});

/**
 * 验码失败时的文案。
 *
 * 每一条都要**告诉用户下一步做什么** —— 「验证码错误」而没有下文，
 * 用户只能反复重试。`too-many-attempts` 尤其要说清「必须重新发送」，
 * 否则他会在一个已作废的码上耗着。
 */
const VERIFY_MESSAGES: Record<Exclude<VerifyOutcome, "ok">, string> = {
  missing: "还没有向该邮箱发送验证码，请先点「发送验证码」。",
  expired: "验证码已过期，请重新发送。",
  invalid: "验证码不正确。",
  "too-many-attempts": "验证码错误次数过多，已作废，请重新发送。",
};

export async function POST(request: Request) {
  let body;
  try {
    body = registerSchema.parse(await request.json());
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

  // 昵称在导航、弹幕、评论里全站可见，属于公开 UGC，同样要过滤。
  if (isBlocked(body.nickname)) {
    return NextResponse.json({ error: "昵称包含被屏蔽的词，请更换" }, { status: 400 });
  }

  const email = body.email.trim().toLowerCase();

  let school;
  let studentNo: string | null;
  try {
    school = await resolveSchoolByEmail(email);
    studentNo = normalizeStudentNo(body.studentNo);
  } catch (error) {
    if (error instanceof SchoolAdmissionError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  /*
   * 校验邮箱验证码。放在「学校解析」之后、查重之前：
   * - 之后：不属于任何学校的邮箱连码都发不出去，先拦更早、报错更准确；
   * - 之前：验码失败就不必查库，也避免给未验证邮箱的请求做更多工作。
   */
  /*
   * 邮件没配好时，注册**整体不可用**（验证码是必填的）。
   *
   * 在验码之前就拦住：否则用户会看到「还没有向该邮箱发送验证码」，
   * 以为是自己的问题而反复重试 —— 实际是部署缺配置。
   */
  announceCapabilities();
  const capabilities = checkCapabilities();
  if (!capabilities.email) {
    return NextResponse.json({ error: capabilities.problems[0] }, { status: 503 });
  }

  const outcome = await verifyCode(email, body.verificationCode);
  if (outcome !== "ok") {
    return NextResponse.json(
      { error: VERIFY_MESSAGES[outcome] },
      // 403 而不是 400：这不是「参数格式错」，而是「凭据不成立」
      { status: 403 },
    );
  }

  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email }, ...(studentNo ? [{ studentNo }] : [])],
    },
    select: { id: true, email: true, studentNo: true },
  });
  if (existing) {
    return NextResponse.json(
      {
        error:
          existing.email === email ? "该邮箱已注册" : "该学号已被使用",
      },
      { status: 409 },
    );
  }

  const user = await prisma.user.create({
    data: {
      email,
      studentNo,
      nickname: body.nickname.trim(),
      passwordHash: await hashPassword(body.password),
      schoolId: school.id,
    },
    select: { id: true, nickname: true, schoolId: true, email: true },
  });

  /*
   * 账号创建成功后**立刻作废验证码** —— 它是一次性的。
   *
   * 放在创建之后而不是验码之后：万一创建失败（并发下唯一约束冲突），
   * 用户不该因此丢掉那个还没用出去的码。
   */
  await consumeCode(email);

  await setSessionCookie(user.id);

  return NextResponse.json(
    {
      user: {
        id: user.id,
        nickname: user.nickname,
        email: user.email,
        schoolId: user.schoolId,
        schoolName: school.name,
      },
    },
    { status: 201 },
  );
}

/** GET /api/auth/register — 暴露当前学校与准入提示，供注册表单预校验。 */
export async function GET() {
  const schools = await prisma.school.findMany({
    select: { id: true, name: true, domains: true },
    orderBy: { id: "asc" },
  });
  const current = await getSessionUser();
  /*
   * `...checkCapabilities()`：注册页据此显示横幅。
   *
   * 邮件没配好时**注册整体不可用**（验证码必填），所以要让用户在
   * **填表之前**就看到，而不是填完才发现收不到验证码。
   */
  return NextResponse.json({ schools, current, ...checkCapabilities() });
}

