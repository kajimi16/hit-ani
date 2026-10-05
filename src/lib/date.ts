/**
 * 日期解析 —— 全局唯一实现。
 *
 * ## 为什么必须只有一份
 *
 * 这个函数（`YYYY-MM-DD` → 当天 UTC 零点）在仓里曾经有**四份**复制品：
 * `import.ts`、`api/subjects/[id]/route.ts`、`subject-fields.ts`、`schedule.ts`。
 * 四份各自演化，其中**三份带着同一个 bug**：
 *
 *     new Date(Date.UTC(2026, 12, 45))  // 不报错 → 2027-02-14
 *
 * `Date.UTC` 对越界的月/日**静默进位**，而 `^\d{4}-\d{2}-\d{2}$` 只保证
 * 「4 位-2 位-2 位」，挡不住 13 月、45 日。于是上游一个坏日期会被我们
 * 悄悄存成另一个日期 —— 用户看到的是凭空捏造的首播时间，且不会有人发现。
 *
 * 收敛到一处之后，任何调用方都自动获得回读校验。
 */

/**
 * 把 `YYYY-MM-DD` 解析为**当天 UTC 零点**；非法输入返回 `null`。
 *
 * 用 UTC 而非本地时间：否则 UTC+8 的机器会把 `2026-01-04` 存成 `2026-01-03`。
 *
 * `null` 而非抛错：日期来自上游，缺失或畸形是常态（未定档条目会返回空串），
 * 调用方按「没有日期」处理即可，不该让整条导入失败。
 */
export function parseIsoDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;

  /*
   * 回读校验：确认没有被 `Date.UTC` 进位。
   * 这三个比较必须都在 —— 只查年的话 `2026-02-30` 会漏（进位后仍是 2026 年）。
   */
  if (date.getUTCFullYear() !== year) return null;
  if (date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;
  return date;
}

/** `Date` → `YYYY-MM-DD`（UTC）。 */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
