import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { SchoolAdmissionError, normalizeStudentNo, resolveSchoolByEmail } from "@/lib/auth/school";
import { getSessionUser, setSessionCookie } from "@/lib/auth/session";
import { prisma } from "@/lib/prisma";

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
});

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
  return NextResponse.json({ schools, current });
}

