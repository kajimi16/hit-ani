import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveSchoolByEmail } from "@/lib/auth/school";
import { announceCapabilities, checkCapabilities } from "@/lib/email/capabilities";
import { createTransport } from "@/lib/email/transport";
import { RESEND_INTERVAL_MS, issueCode, normalizeEmail } from "@/lib/email/verification";
import { prisma } from "@/lib/prisma";
import { TokenBucketLimiter } from "@/lib/danmaku/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(254),
});

/**
 * 按 IP 限流。
 *
 * 邮箱级的 60 秒节流挡不住「换邮箱轰炸」，因此在接口层再按 IP 限一道。
 * 容量 5、每秒回填 1/30 → 稳态约 2 次/分钟，突发 5 次。
 * 单进程内存即可：本站是单容器部署，且这不涉及跨进程一致性。
 */
const ipLimiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 / 30 });

/** 从代理头里取真实来源 IP（镜像部署时 `x-forwarded-for` 可能有多跳）。 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * POST /api/auth/email/send-code — 发送注册验证码。
 *
 * ## 强制验证（用户选择）
 *
 * 未配置邮件传输时**直接拒绝**，并说明是部署问题 —— 不能静默降级成
 * 「不用验证也能注册」，那等于把这道防线撤掉而用户毫无察觉。
 *
 * ## 不透露邮箱是否已注册
 *
 * 对「已注册的邮箱」与「未注册的邮箱」返回相同的响应。否则这个接口
 * 就成了**账号枚举器**：攻击者可以批量探测哪些校内邮箱注册过本站。
 */
export async function POST(request: Request) {
  let body;
  try {
    body = schema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "请输入有效的邮箱地址" }, { status: 400 });
  }

  /*
   * 邮件未配置时**明确拒绝**并说明缺什么。
   *
   * 不做降级：用户选择的策略是「强制验证」，未配置时放行注册等于悄悄撤掉
   * 那道防线。这里把诊断写清楚，让运维一眼知道该配哪个变量。
   */
  announceCapabilities();
  const capabilities = checkCapabilities();
  if (!capabilities.email) {
    return NextResponse.json({ error: capabilities.problems[0] }, { status: 503 });
  }

  const transport = createTransport();
  // 上一行已经确认配置存在；这里只是给类型收窄（`createTransport` 的返回是
  // 可空的，因为「没配置」是它的合法状态）。
  if (!transport) {
    return NextResponse.json({ error: capabilities.problems[0] }, { status: 503 });
  }

  const email = normalizeEmail(body.email);

  // 按 IP 限流先于一切 —— 包括「邮箱是否合法」的判断
  const decision = ipLimiter.consume(clientIp(request));
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `请求过于频繁，请 ${Math.ceil(decision.retryAfterMs / 1000)} 秒后再试` },
      { status: 429 },
    );
  }

  /*
   * 学校白名单：不属于任何学校的邮箱连验证码都不发 ——
   * 发了也注册不了，白白消耗发信配额。
   */
  const school = await resolveSchoolByEmail(email).catch(() => null);
  if (!school) {
    return NextResponse.json(
      { error: "该邮箱不属于任何已登记的学校域名，无法注册。" },
      { status: 400 },
    );
  }

  // 已完成注册流程时不必再发码。但**响应不变**（防枚举）。
  const alreadyRegistered = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (!alreadyRegistered) {
    const issued = await issueCode(email, clientIp(request));
    if (!issued.ok) {
      return NextResponse.json(
        {
          error: `请 ${Math.ceil(issued.retryAfterMs / 1000)} 秒后再试`,
          retryAfterMs: issued.retryAfterMs,
        },
        { status: 429 },
      );
    }

    try {
      await transport.send({
        to: email,
        subject: "hit-ani 注册验证码",
        text: [
          `你的注册验证码是：${issued.code}`,
          "",
          `有效期 10 分钟。若非本人操作，忽略本邮件即可。`,
          "",
          "—— hit-ani 校内动漫平台",
        ].join("\n"),
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: `邮件发送失败：${error instanceof Error ? error.message : String(error)}`,
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    ok: true,
    /** 前端用它显示倒计时，避免用户连点。 */
    resendAfterMs: RESEND_INTERVAL_MS,
  });
}
