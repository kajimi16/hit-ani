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
 *
 * ## 三道判定（按顺序）
 *
 * 1. **`BGM_MIRROR_ENABLED=0`** —— 运维硬闸。整批跑写库测试时用它，
 *    压过一切（包括用户自己的选择）。
 * 2. **测试账号模式** —— 安全兜底。邮箱匹配测试模式的账号一律不写上游，
 *    自动生效、不依赖记忆。
 * 3. **用户偏好**（`User.mirrorToBgm`，**默认关闭**）—— 写上游是不可撤销的，
 *    会覆盖用户在 Bangumi 上已有的内容。默认替他打开等于替他做决定，
 *    因此必须由用户显式开启。
 *
 * ## 为什么返回「原因码」而不只是文案
 *
 * 早先只返回一句中文原因，于是 **`BGM_MIRROR_ENABLED=0` 这句内部术语直接
 * 漏到了用户界面上**，而界面还把它显示成「同步失败」—— 但用户根本没开过
 * 这个功能，不存在「失败」。
 *
 * 现在返回 `code`，由界面决定说法：未开启 ≠ 被管理员关闭 ≠ 真的写失败了。
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

/**
 * 不做镜像的原因码。
 *
 * - `user-disabled`：用户自己没开（**默认状态**）—— 不是错误，界面应引导去设置页
 * - `ops-disabled`：运维硬闸关闭（跑写库测试时）
 * - `test-account`：测试账号，安全兜底
 */
export type MirrorSkipCode = "user-disabled" | "ops-disabled" | "test-account";

export interface MirrorDecision {
  /** 是否允许写上游 */
  allowed: boolean;
  /** 拒绝原因（英文短句，给日志与排查用；界面用 `code` 决定文案） */
  reason: string | null;
  /** 不做镜像的原因码；`allowed` 为 true 时为 null */
  code: MirrorSkipCode | null;
}

/**
 * 判断该账号的上游写入是否被允许。
 *
 * ## 决策顺序（安全优先）
 *
 * 1. 运维硬闸 → 2. 测试账号 → 3. 用户偏好。
 * 硬闸必须在最前：跑写库测试时不能被用户设置绕过。
 *
 * ## 但**上报的原因码**按另一种顺序
 *
 * 原因码是给界面用的，要挑「对这个用户最相关」的那条：
 *
 * - 用户**没开同步** → 报 `user-disabled`（哪怕同时还有硬闸）。
 *   这时对用户来说就是「我没开这个功能」，界面**静默处理**——
 *   告诉一个从没开过同步的人「同步被管理员关闭」既莫名其妙，
 *   还会在他每次操作时重复出现（实测这条提示是常驻的，不会自动消失）。
 * - 用户**开了同步**却被硬闸挡住 → 报 `ops-disabled`。这时他确实需要知道
 *   「我开了，但暂时不生效」，否则会以为同步坏了。
 *
 * 实测教训：硬闸开着时 `ops-disabled` 会遮蔽 `user-disabled`，
 * 于是**所有人的每次操作**都看到「被管理员临时关闭」。
 */
export function decideMirror(input: {
  email: string | null | undefined;
  /**
   * 用户是否在设置里开启了同步（`User.mirrorToBgm`，默认 false）。
   *
   * **必填**（不是可选）—— 否则「忘了传」会静默退化成「允许写入」，
   * 而这是不可撤销的写操作。必填让编译器替我们挡住这种遗漏。
   */
  mirrorToBgm: boolean;
}): MirrorDecision {
  const email = input.email ?? "";
  const opsDisabled = process.env.BGM_MIRROR_ENABLED === "0";
  const isTestAccount = TEST_ACCOUNT_PATTERNS.some((pattern) => pattern.test(email));

  if (opsDisabled || isTestAccount || !input.mirrorToBgm) {
    /*
     * 挑最相关的原因码 —— 见上方说明。顺序：用户没开 > 运维硬闸 > 测试账号。
     *
     * 用户没开时**先返回**，因此不会被硬闸遮蔽。
     */
    if (!input.mirrorToBgm) {
      return {
        allowed: false,
        reason: "user has not enabled Bangumi sync",
        code: "user-disabled",
      };
    }
    if (opsDisabled) {
      return {
        allowed: false,
        reason: "ops kill switch (BGM_MIRROR_ENABLED=0)",
        code: "ops-disabled",
      };
    }
    return {
      allowed: false,
      reason: `test account pattern matched: ${email}`,
      code: "test-account",
    };
  }

  return { allowed: true, reason: null, code: null };
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
