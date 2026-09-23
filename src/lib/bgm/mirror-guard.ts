/**
 * 上游镜像的闸门与审计日志。
 *
 * ## 背景：真实事故
 *
 * 2026-09-23，我用 `curl` 以**用户本人账号**（已绑定 Bangumi）调了
 * `PUT /api/collections`，body 里带了测试文案 —— 于是这条测试数据
 * **真的写进了用户的 Bangumi 账号**，覆盖了他自己写的短评。
 *
 * 根因是设计缺陷，不是疏忽：
 * `collection-actions.ts` 里 `if (bgmBound)` 就直接发请求，**没有任何闸门**。
 * 于是「拿真实账号做接口冒烟」必然污染真实数据，而且事后无法从代码看出发生过什么。
 *
 * ## 两道防护
 *
 * 1. **测试账号自动拒绝镜像**：邮箱匹配测试模式的账号一律不写上游。
 *    这是自动的、不依赖记忆，因此能真正防住「下次又忘了」。
 * 2. **`BGM_MIRROR_ENABLED=0` 显式总开关**：需要整批跑写库测试时用它。
 *
 * 另外每次成功的上游写入都记一行日志 —— 出事时能查「写过什么」。
 */

/**
 * 禁止镜像到上游的邮箱模式。
 *
 * 覆盖两种命名习惯：**本地部分以测试词开头**（`smoke-123@`、`smoke@`）
 * 与 **带分隔符的变体**（`-test@`、`+test@`）。
 * 前者用 `^词(分隔符|@)` 一次覆盖 —— 只写 `^smoke[-.]` 会漏掉 `smoke@x` 这种。
 */
const TEST_ACCOUNT_PATTERNS: readonly RegExp[] = [
  /^(smoke|test|e2e)([-._+]|@)/i,
  /[-._+](smoke|test|e2e)@/i,
];

export interface MirrorDecision {
  /** 是否允许写上游 */
  allowed: boolean;
  /** 拒绝原因（allowed 为 false 时必有） */
  reason: string | null;
}

/**
 * 判断该账号的上游写入是否被允许。
 *
 * 顺序有讲究：**先看显式开关，再看测试账号模式** ——
 * 前者是运维意图（明确要求关闭），后者是安全兜底。
 */
export function decideMirror(input: { email: string | null | undefined }): MirrorDecision {
  if (process.env.BGM_MIRROR_ENABLED === "0") {
    return { allowed: false, reason: "BGM_MIRROR_ENABLED=0，已全局关闭上游镜像" };
  }

  const email = input.email ?? "";
  for (const pattern of TEST_ACCOUNT_PATTERNS) {
    if (pattern.test(email)) {
      return {
        allowed: false,
        reason: `账号 ${email} 匹配测试模式，拒绝对 Bangumi 发起写入`,
      };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * 记录一次上游写入。
 *
 * 为什么要日志：事故发生时，第一件要做的事是回答「到底改了什么」。
 * 没有日志就只能靠 grep 代码与猜时间线 —— 这次正是如此，代价很高。
 */
export function logMirrorWrite(input: {
  userId: string;
  email: string | null | undefined;
  target: "collection" | "episode-progress";
  subjectId?: number;
  episodeId?: number;
  fields: Record<string, unknown>;
}): void {
  const target =
    input.target === "collection"
      ? `subject=${input.subjectId}`
      : `episode=${input.episodeId}`;
  console.log(
    `[bgm-mirror] ${input.email ?? input.userId} → ${target} ` +
      `${JSON.stringify(input.fields)}`,
  );
}
