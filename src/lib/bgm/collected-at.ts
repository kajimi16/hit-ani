/**
 * BGM 收藏记录的 `updated_at` 解析。
 *
 * 抽成独立模块（而不是留在 `import.ts` 里）是因为它要能被测试直接引用 ——
 * 一个坏时间会让「按加入时间排序」把那条顶到最前或沉到最底，而这类错误
 * 在界面上只表现为「顺序有点怪」，极难归因。
 */

/**
 * 解析 BGM 收藏记录的 `updated_at`。
 *
 * 上游给的是 ISO 字符串（`2026-09-22T18:27:26.406Z`，也可能带 `+08:00` 偏移），
 * 直接交给 `new Date()` 即可。
 *
 * **必须校验结果**：非法字符串会得到 `Invalid Date`，把它写进时间列会抛错，
 * 而更隐蔽的是「能解析但差得离谱」的值（例如把空串当 0 → 1970 年）——
 * 那会让这条永远排在「最近加入」的最前面。因此只接受 `YYYY-MM-DD` 开头的
 * 字符串，并要求年月日合理。
 */
export function parseCollectedAt(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // 只认形如 2026-09-22T... 或 2026-09-22 的输入，避免把 "0" / "1" 之类的
  // 意外值当成时间戳（`new Date("1")` 在部分引擎上是 2001 年）
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;

  // 年份合理性：1970 或 3000 年都说明上游给了奇怪的东西
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) return null;
  return date;
}
