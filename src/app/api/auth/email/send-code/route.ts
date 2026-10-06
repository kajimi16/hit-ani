import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveSchoolByEmail } from "@/lib/auth/school";
import { announceCapabilities, checkCapabilities } from "@/lib/email/capabilities";
import { createTransport } from "@/lib/email/transport";
import { RESEND_INTERVAL_MS, issueCode, normalizeEmail } from "@/lib/email/verification";
import { TokenBucketLimiter } from "@/lib/danmaku/rate-limit";
import { clientIp } from "@/lib/net/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().email().max(254),
});

/**
 * 限流：两道，主防线是**全局**那道。
 *
 * ## 为什么不能只按 IP 限流
 *
 * Next 的路由处理器拿不到 socket 地址，只能读 `X-Forwarded-For`；而实测确认
 * **Next 会直接透传客户端发的这个头** —— 伪造 `9.9.9.1` 后，库里存的就是
 * `9.9.9.1`，没有任何追加的真实地址。于是伪造它即可每次都是「新 IP」：
 *
 *     不伪造   → 第 6 次请求被 429
 *     伪造 XFF → 连续 8 次**全部通过**
 *
 * 因此 IP 那道只能算补充（它对不伪造头的普通滥用有效；将来若在可信代理
 * 后面部署、且代理剥掉入站同名头，它会重新变得可靠）。
 *
 * ## 全局那道才是真正拦得住的
 *
 * 它不依赖任何请求头，伪造无从下手。取值权衡：校园场景下开学时可能有一批
 * 学生同时注册（每人 1–2 封），所以容量给得比单 IP 那道宽；但**必须有上界**
 * —— 被脚本刷时会把学校 SMTP 的信誉打掉，整个注册功能随之不可用，
 * 那比「暂时限流」糟得多。
 *
 * 单进程内存即可：本站是单容器部署，不涉及跨进程一致性。
 */
const globalLimiter = new TokenBucketLimiter({ capacity: 30, refillPerSecond: 1 / 2 });
const ipLimiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 / 30 });


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

  /*
   * 限流先于一切 —— 包括「邮箱是否合法」的判断。
   *
   * **先查全局那道**：它不可伪造，是主防线。ipaly 那道只作补充。
   */
  const global = globalLimiter.consume("all");
  if (!global.allowed) {
    return NextResponse.json(
      { error: `发送过于频繁，请 ${Math.ceil(global.retryAfterMs / 1000)} 秒后再试` },
      { status: 429 },
    );
  }

  const perIp = ipLimiter.consume(clientIp(request.headers));
  if (!perIp.allowed) {
    return NextResponse.json(
      { error: `请求过于频繁，请 ${Math.ceil(perIp.retryAfterMs / 1000)} 秒后再试` },
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

  /*
   * **不看该邮箱是否已注册** —— 一律签发并发信。
   *
   * 早先的实现会在「已注册」时跳过发信，注释写着「响应不变（防枚举）」。
   * 实测那**不成立**：
   *
   *     已注册邮箱  → 200（跳过了发信，很快）
   *     未注册邮箱  → 502（走了发信，SMTP 有问题时直接失败）
   *
   * 也就是说失败模式下**状态码不同**、正常模式下**耗时差两个数量级**
   * （跳过发信 ~1ms vs 发信 ~100ms）—— 后者同样是可测量的枚举信道。
   *
   * 现在两种邮箱走**完全相同**的路径：都签发、都发信、都返回 200。
   * 代价是给已注册邮箱多发一封（注册时仍会被 409 拒绝），
   * 换来这条注释里声称的属性真正成立。
   */
  const issued = await issueCode(email, clientIp(request.headers));
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

  return NextResponse.json({
    ok: true,
    /** 前端用它显示倒计时，避免用户连点。 */
    resendAfterMs: RESEND_INTERVAL_MS,
  });
}
