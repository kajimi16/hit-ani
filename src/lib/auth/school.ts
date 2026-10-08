/**
 * 校内注册准入：邮箱域名 / 学号白名单 → schoolId。
 *
 * `schoolId` 是「本校弹幕」这一核心卖点的**唯一依据**（见 `lib/danmaku` 的
 * 本校筛选、以及好友/时光机的学校隔离）。因此校验必须在服务端、且以 School 表为准。
 *
 * ## 开放注册（默认关闭）
 *
 * 有些部署里「校内同学未必都有本校域名邮箱」（例如学校给的部分邮箱不在
 * `School.domains` 里，或同学习惯用个人邮箱）。设
 * `REGISTRATION_FALLBACK_SCHOOL_ID=<schoolId>` 后：
 *
 * - 域名**匹配**到某所学校 → 仍归那所（保持精确归属）；
 * - 域名**不匹配** → 归入该 fallback 学校，而不是拒绝注册。
 *
 * ### 为什么默认关闭
 *
 * 打开它等于把「校内」的判定从「持有本校邮箱」降级为「能访问本站 + 会用一个邮箱」。
 * 对自建校园站这通常可接受（站点在校园网内，校外本来就访问不到），但它**确实**
 * 改变了核心功能「只看本校弹幕」的含义 —— 那种改变不该由升级代码悄悄做掉，
 * 所以要求显式配置。未配置时的行为与改动前**逐字相同**。
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

/** 开放注册的 fallback 学校 id 的环境变量名。 */
export const FALLBACK_SCHOOL_ENV = "REGISTRATION_FALLBACK_SCHOOL_ID";

/**
 * 读取 fallback 学校 id。
 *
 * 用 `?.trim() || null` 而不是 `??` —— 空字符串必须等同未设置
 * （`.env` 里写 `X=` 是很常见的「关掉它」写法，`??` 会把它当成有效值）。
 */
export function fallbackSchoolId(
  raw: string | undefined = process.env[FALLBACK_SCHOOL_ENV],
): string | null {
  return raw?.trim() || null;
}

/** 从邮箱取域名，小写。 */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * 决策：这份邮箱该归入哪所学校。
 *
 * **纯函数** —— 不碰数据库，因此「域名匹配优先、fallback 兜底」这套规则
 * 可以直接测（DB 版只是把学校清单读出来喂给它）。
 *
 * 返回 `{ school }` 或 `{ reason }`（拒绝原因，用于给用户看的提示）。
 */
export function chooseSchool(
  schools: SchoolRecord[],
  domain: string | null,
  fallbackId: string | null,
): { school: SchoolRecord } | { reason: string } {
  if (!domain) return { reason: "邮箱格式不正确" };

  // 精确归属优先：多校预留，域名冲突时按 id 升序取第一个，保证结果确定
  const matched = schools
    .filter((school) => school.domains.includes(domain))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  if (matched) return { school: matched };

  if (!fallbackId) {
    return { reason: `邮箱域名 ${domain} 不在允许注册的学校列表中` };
  }

  const fallback = schools.find((school) => school.id === fallbackId);
  if (!fallback) {
    /*
     * 配错了要**响亮失败**（而不是退回白名单模式）。
     *
     * 退回白名单会让「我明明配了开放注册」变成「还是注册不了」，
     * 而报错信息指向邮箱域名 —— 与真实原因（学校 id 拼错）完全无关。
     */
    return { reason: `开放注册已启用，但 ${FALLBACK_SCHOOL_ENV}=${fallbackId} 不是有效的学校 id` };
  }
  return { school: fallback };
}

/**
 * 依据邮箱解析学校。
 *
 * 读出全部学校再交给 `chooseSchool` —— 表里只有个位数行，而注册是低频操作，
 * 一次全量读换来「决策逻辑可测」是值得的（原先的定向查询把规则埋进了 SQL 里）。
 */
export async function resolveSchoolByEmail(email: string): Promise<SchoolRecord> {
  const schools = await prisma.school.findMany({
    select: { id: true, name: true, domains: true },
  });

  const decision = chooseSchool(schools, emailDomain(email), fallbackSchoolId());
  if ("reason" in decision) throw new SchoolAdmissionError(decision.reason);
  return decision.school;
}

/** 学号格式校验。各校规则不同，此处只做「非空 + 长度上限」，避免误杀。 */
export function normalizeStudentNo(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value.length > 32) throw new SchoolAdmissionError("学号过长");
  return value;
}

let announced = false;

/** 允许重复打印（测试用）。与 `net/egress.ts`、`fetcher.ts` 同一套理由。 */
export function resetRegistrationAnnouncement(): void {
  announced = false;
}

/**
 * 启动时说明注册准入口径。
 *
 * 这条值得打：它直接决定「谁能注册」，而两种模式的**用户体验差别极大**
 * （一种「任何邮箱都行」，另一种「只有本校邮箱」）。排查「同学说注册不了」
 * 时第一眼要看的就是它。
 */
export async function announceRegistrationAdmission(
  log: (message: string) => void = console.warn,
): Promise<void> {
  if (announced) return;
  announced = true;

  const fallback = fallbackSchoolId();
  if (!fallback) {
    log("[registration] 白名单模式（仅 School.domains 里的邮箱可注册）");
    return;
  }

  const school = await prisma.school
    .findUnique({ where: { id: fallback }, select: { id: true, name: true } })
    .catch(() => null);

  if (!school) {
    log("");
    log("================================================================");
    log(`⚠️  ${FALLBACK_SCHOOL_ENV}=${fallback} 不是有效的学校 id。`);
    log("   开放注册会对每个非匹配域名报错（而不是退回白名单）——");
    log("   否则「配了开放注册却还是注册不了」会以「邮箱域名不允许」的形式");
    log("   出现，与真实原因完全无关。");
    log("   查现有学校：npm run admin:grant:docker -- --list 之外，见 School 表。");
    log("================================================================");
    log("");
    return;
  }

  log(`[registration] 开放注册：非匹配域名归入 ${school.name}（${school.id}）`);
}
