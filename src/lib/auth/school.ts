/**
 * 校内注册准入：邮箱域名 / 学号白名单 → schoolId。
 *
 * 这是「本校弹幕」这一核心卖点的准入边界：只有通过校验的账号才能拿到 schoolId，
 * 而 schoolId 是所有校内筛选的唯一依据。因此校验必须在服务端、且以 School 表为准。
 */

import { prisma } from "@/lib/prisma";

export interface SchoolRecord {
  id: string;
  name: string;
  domains: string[];
}

export class SchoolAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchoolAdmissionError";
  }
}

/** 从邮箱取域名，小写。 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * 依据邮箱域名解析学校。
 * 多校预留：域名冲突时按 `School.id` 升序取第一个，保证结果确定。
 */
export async function resolveSchoolByEmail(email: string): Promise<SchoolRecord> {
  const domain = emailDomain(email);
  if (!domain) throw new SchoolAdmissionError("邮箱格式不正确");

  const school = await prisma.school.findFirst({
    where: { domains: { has: domain } },
    orderBy: { id: "asc" },
    select: { id: true, name: true, domains: true },
  });

  if (!school) {
    throw new SchoolAdmissionError(`邮箱域名 ${domain} 不在允许注册的学校列表中`);
  }
  return school;
}

/** 学号格式校验。各校规则不同，此处只做「非空 + 长度上限」，避免误杀。 */
export function normalizeStudentNo(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > 32) throw new SchoolAdmissionError("学号过长");
  return value;
}
