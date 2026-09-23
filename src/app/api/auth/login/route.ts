import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import { clearSessionCookie, getSessionUser, setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginSchema = z.object({
  /** 邮箱或学号 */
  identifier: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
});

/**
 * POST /api/auth/login
 * body: { identifier, password }
 */
export async function POST(request: Request) {
  let body;
  try {
    body = loginSchema.parse(await request.json());
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

  const identifier = body.identifier.trim();
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: identifier.toLowerCase() }, { studentNo: identifier }],
    },
    select: { id: true, nickname: true, passwordHash: true, schoolId: true, email: true },
  });

  // 用户不存在时也走一次散列比对，避免通过响应时间枚举账号
  const stored = user?.passwordHash ?? DUMMY_HASH;
  const ok = await verifyPassword(body.password, stored);

  if (!user || !ok) {
    return NextResponse.json({ error: "账号或密码错误" }, { status: 401 });
  }

  await setSessionCookie(user.id);
  return NextResponse.json({
    user: {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      schoolId: user.schoolId,
    },
  });
}

/** GET /api/auth/login — 当前会话状态。 */
export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ user: null }, { status: 200 });
  return NextResponse.json({ user });
}

/** DELETE /api/auth/login — 退出登录。 */
export async function DELETE() {
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}

/** 固定假散列：与真实散列同为 scrypt 格式，保证比对耗时一致。 */
const DUMMY_HASH =
  "scrypt$AAAAAAAAAAAAAAAAAAAAAA$" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
