/**
 * 注册准入的决策逻辑测试。
 *
 * ## 为什么要单独测这个
 *
 * `chooseSchool` 决定 `schoolId`，而 `schoolId` 是「只看本校弹幕」的**唯一依据**。
 * 它出错的方式都很安静：
 *
 * - 域名匹配优先级弄反 → 用本校邮箱的人被归到 fallback 学校，**看不到本校弹幕**；
 * - 多校域名冲突没定序 → 同一封邮箱在不同请求里可能归到不同学校（结果不确定）；
 * - fallback 配了个不存在的 id → 若「静默退回白名单」，报错会指向**邮箱域名**，
 *   而真实原因是学校 id 拼错 —— 与真实原因无关的报错最难查。
 *
 * 所以这里把规则钉死在纯函数上（不碰数据库）。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import {
  FALLBACK_SCHOOL_ENV,
  SchoolAdmissionError,
  chooseSchool,
  emailDomain,
  fallbackSchoolId,
  normalizeStudentNo,
  resetRegistrationAnnouncement,
  resolveSchoolByEmail,
  type SchoolRecord,
} from "@/lib/auth/school";

const HIT: SchoolRecord = { id: "hit", name: "哈工大", domains: ["hit.edu.cn", "stu.hit.edu.cn"] };
const OTHER: SchoolRecord = { id: "aaa-other", name: "他校", domains: ["example.edu"] };

/* ================================================================== *
 * 默认行为必须与改动前逐字相同
 * ================================================================== */

test("★ 未配置 fallback 时，非匹配域名被拒绝（与改动前行为相同）", () => {
  const decision = chooseSchool([HIT], "qq.com", null);
  assert.ok("reason" in decision, "应拒绝");
  // 报错文案也要保持原样 —— 它会直接显示给用户
  assert.match(decision.reason, /qq\.com/);
  assert.match(decision.reason, /不在允许注册的学校列表中/);
});

test("★ 空字符串等同未设置 —— `.env` 里写 `X=` 是常见的「关掉它」写法", () => {
  // 用 `??` 会把它当成有效值，于是「关掉了却还在用某个学校 id」
  assert.equal(fallbackSchoolId(""), null);
  assert.equal(fallbackSchoolId("   "), null);
  assert.equal(fallbackSchoolId("hit"), "hit");
  assert.equal(fallbackSchoolId("  hit  "), "hit", "两侧空白要 trim");
});

test("从环境变量读取（不传实参时）—— 未设置/空白都当没配", () => {
  const saved = process.env[FALLBACK_SCHOOL_ENV];
  try {
    delete process.env[FALLBACK_SCHOOL_ENV];
    assert.equal(fallbackSchoolId(), null, "未设置应为 null");
    process.env[FALLBACK_SCHOOL_ENV] = "";
    assert.equal(fallbackSchoolId(), null, '空字符串应为 null（`X=` 的写法）');
    process.env[FALLBACK_SCHOOL_ENV] = "somewhere";
    assert.equal(fallbackSchoolId(), "somewhere");
  } finally {
    if (saved === undefined) delete process.env[FALLBACK_SCHOOL_ENV];
    else process.env[FALLBACK_SCHOOL_ENV] = saved;
  }
});

/* ================================================================== *
 * 域名匹配优先
 * ================================================================== */

test("★ 域名匹配优先于 fallback —— 否则本校邮箱的人看不到本校弹幕", () => {
  const decision = chooseSchool([HIT, OTHER], "stu.hit.edu.cn", "aaa-other");
  assert.ok("school" in decision);
  assert.equal(decision.school.id, "hit", "匹配到就必须归匹配的那所，不能被 fallback 抢走");
});

test("非匹配域名归入 fallback（这就是「开放注册」）", () => {
  const decision = chooseSchool([HIT, OTHER], "qq.com", "hit");
  assert.ok("school" in decision);
  assert.equal(decision.school.id, "hit");
});

test("域名大小写不敏感、前后空白被忽略（邮箱大小写本来就无意义）", () => {
  assert.equal(emailDomain("  Foo@HIT.EDU.CN "), "hit.edu.cn");
  assert.equal(emailDomain("a@b@hit.edu.cn"), "hit.edu.cn", "取最后一个 @ 之后");
});

test("邮箱格式不对仍然拒绝（与开放注册无关）", () => {
  assert.equal(emailDomain("没有 at 符号"), null);
  assert.equal(emailDomain("@hit.edu.cn"), null, "@ 在开头");
  assert.equal(emailDomain("x@"), null, "@ 在结尾");
  for (const bad of ["没有 at 符号", "@hit.edu.cn", "x@"]) {
    const decision = chooseSchool([HIT], emailDomain(bad), "hit");
    assert.ok("reason" in decision, `${bad} 应被拒绝`);
    assert.match(decision.reason, /格式/);
  }
});

/* ================================================================== *
 * 多校域名冲突必须确定性
 * ================================================================== */

test("★ 两个学校都声明同一域名时，按 id 升序取第一个（结果确定）", () => {
  const a: SchoolRecord = { id: "aaa", name: "A", domains: ["shared.edu"] };
  const b: SchoolRecord = { id: "zzz", name: "Z", domains: ["shared.edu"] };
  // 正反两种输入顺序都必须得到同一个结果
  for (const list of [
    [a, b],
    [b, a],
  ]) {
    const decision = chooseSchool(list, "shared.edu", null);
    assert.ok("school" in decision);
    assert.equal(decision.school.id, "aaa", "必须按 id 升序，否则同一邮箱可能归不同学校");
  }
});

/* ================================================================== *
 * 配错要响亮失败
 * ================================================================== */

test("★ fallback 指向不存在的学校 id → 报错必须指向**配置**，而不是邮箱域名", () => {
  const decision = chooseSchool([HIT], "qq.com", "no-such-school");
  assert.ok("reason" in decision, "必须拒绝（而不是静默退回白名单）");
  assert.match(decision.reason, /no-such-school/, "报错要含那个错的 id");
  assert.match(decision.reason, new RegExp(FALLBACK_SCHOOL_ENV), "报错要指出该改哪个变量");
  // 关键：不能是「域名不允许」那种误导性文案
  assert.doesNotMatch(decision.reason, /不在允许注册的学校列表中/);
});

test("学校列表为空且有 fallback → 同样报配置错（不是「域名不允许」）", () => {
  const decision = chooseSchool([], "qq.com", "hit");
  assert.ok("reason" in decision);
  assert.match(decision.reason, /不是有效的学校 id/);
});

/* ================================================================== *
 * 启动时的口径播报
 * ================================================================== */

test("★ 启动时播报准入口径 —— 两种模式先说清楚", async () => {
  const capture = async (envValue: string | undefined): Promise<string[]> => {
    const saved = process.env[FALLBACK_SCHOOL_ENV];
    if (envValue === undefined) delete process.env[FALLBACK_SCHOOL_ENV];
    else process.env[FALLBACK_SCHOOL_ENV] = envValue;
    resetRegistrationAnnouncement();
    const lines: string[] = [];
    try {
      // 用真实学校表（库里是 id=hit）—— 这条同时也验证了「配置真的生效」
      await (await import("@/lib/auth/school")).announceRegistrationAdmission((m) => lines.push(m));
    } finally {
      if (saved === undefined) delete process.env[FALLBACK_SCHOOL_ENV];
      else process.env[FALLBACK_SCHOOL_ENV] = saved;
    }
    return lines;
  };

  const closed = await capture(undefined);
  assert.equal(closed.length, 1, JSON.stringify(closed));
  assert.match(closed[0], /白名单/);

  const open = await capture("hit");
  assert.equal(open.length, 1, JSON.stringify(open));
  assert.match(open[0], /开放注册/);
  assert.match(open[0], /hit/);

  const broken = await capture("no-such-school");
  assert.ok(
    broken.some((l) => l.includes("⚠️")),
    `配错必须喊出来，实际：${JSON.stringify(broken)}`,
  );
});

/* ================================================================== *
 * 学号：保持现状（只做长度校验，不强制）
 * ================================================================== */

test("学号保持可选，只挡过长", () => {
  assert.equal(normalizeStudentNo(undefined), null);
  assert.equal(normalizeStudentNo(null), null);
  assert.equal(normalizeStudentNo("   "), null, "全空白等同没填");
  assert.equal(normalizeStudentNo(" 2024311524 "), "2024311524");
  assert.throws(() => normalizeStudentNo("x".repeat(33)), SchoolAdmissionError);
});

/* ================================================================== *
 * 数据库路径：确认它真的用了同一套规则
 * ================================================================== */

test("resolveSchoolByEmail 走库时也遵守「匹配优先、fallback 兜底」", async () => {
  const saved = process.env[FALLBACK_SCHOOL_ENV];
  try {
    /*
     * 库里现有 hit / demo-other。用 `demo-other`（`example.edu`）当 fallback，
     * 这样能同时验证两件事：命中域名的仍归命中者，未命中的才归 fallback。
     */
    process.env[FALLBACK_SCHOOL_ENV] = "demo-other";

    const matched = await resolveSchoolByEmail("someone@stu.hit.edu.cn");
    assert.equal(matched.id, "hit", "命中 hit 域名必须归 hit");

    const unmatched = await resolveSchoolByEmail("someone@qq.com");
    assert.equal(unmatched.id, "demo-other", "未命中才归 fallback");
  } finally {
    if (saved === undefined) delete process.env[FALLBACK_SCHOOL_ENV];
    else process.env[FALLBACK_SCHOOL_ENV] = saved;
  }
});

after(() => prisma.$disconnect());
