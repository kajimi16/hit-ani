/**
 * Prisma 错误判定。
 *
 * 抽出来是因为两个 OAuth 绑定模块（Bangumi / QQ）都要用同一套判定，而它们
 * 的行为必须一致：把「唯一约束冲突」翻译成可读提示，绝不把 Prisma 原文
 * 漏给用户。
 */

/**
 * 是否是唯一约束冲突（Prisma `P2002`）。
 *
 * 用 `in` + 比较窄化，不给 `error` 套一个「我猜的形状」再读字段 ——
 * 那样写即使形状不对也不会报错，读出来是错的。
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
