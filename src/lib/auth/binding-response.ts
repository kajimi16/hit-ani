/**
 * 绑定接口的错误 → HTTP 响应映射。
 *
 * 抽成无框架的纯函数，是为了能直接验证**用户实际看到的东西**（状态码 + 正文），
 * 而不必为了测这几行去起服务、打网络。
 *
 * 为什么值得单独存在：这里出过一次真实事故 —— 唯一约束冲突没被识别，
 * 于是把 `Invalid prisma.bgmBinding.upsert() invocation: Unique constraint
 * failed on the fields: (bgmUserId)` 原样返回给了用户。那句话既没有说明
 * 发生了什么，也没告诉用户能做什么。
 */

import { BgmAccountTakenError } from "./bgm-oauth";

export interface ErrorResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * 把绑定过程中的异常翻译成给用户的响应。
 *
 * - `BgmAccountTakenError` → 409，带机器可读的 `code`，界面据此弹出
 *   「是否迁移」的确认。用 409（冲突）而不是 400（请求有问题）——
 *   请求本身完全合法，是资源状态冲突。
 * - 其它错误 → 400，附原始信息（上游校验失败等，本来就该让用户看到）。
 */
export function bindingErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof BgmAccountTakenError) {
    return {
      status: 409,
      body: {
        error: error.message,
        code: "BGM_ACCOUNT_TAKEN",
        bgmUserId: error.bgmUserId,
        bgmUsername: error.bgmUsername,
      },
    };
  }

  return {
    status: 400,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}
