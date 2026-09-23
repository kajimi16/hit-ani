/**
 * 新番时间表的日期计算。
 *
 * Bangumi `v0` 无时间表端点，时间表由 `POST /v0/search/subjects` 的
 * `air_date` 区间过滤聚合而来 —— 因此周区间的计算必须确定性、可测。
 */

/** 以周一为一周起点，`weekOffset` 为周偏移（可负）。全部按 UTC 计算，避免服务器时区漂移。 */
export function weekRange(now: Date, weekOffset = 0): { start: Date; end: Date } {
  const day = now.getUTCDay(); // 0 = 周日
  const mondayOffset = day === 0 ? -6 : 1 - day;

  const start = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + mondayOffset + weekOffset * 7,
    ),
  );
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  return { start, end };
}

/** `YYYY-MM-DD`。 */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** 把 `YYYY-MM-DD` 解析为 UTC 零点；非法输入返回 null。 */
export function parseIsoDate(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

/** 相对周一的天序号（0–6）→ 中文星期。 */
export function weekdayLabel(date: Date, weekStart: Date): string {
  const index = Math.round((date.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
  return WEEKDAY_LABELS[index] ?? "";
}
