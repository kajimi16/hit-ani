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

/*
 * 日期解析与格式化统一用 `@/lib/date`（全局唯一实现，带进位校验）。
 * 这里转发是为了保持 `@/lib/schedule` 既有的导入路径可用 ——
 * 时间表的调用方关心的是「周区间」，不该被迫记住日期工具在哪个模块。
 */
export { isoDate, parseIsoDate } from "@/lib/date";

export const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

/** 相对周一的天序号（0–6）→ 中文星期。 */
export function weekdayLabel(date: Date, weekStart: Date): string {
  const index = Math.round((date.getTime() - weekStart.getTime()) / (24 * 60 * 60 * 1000));
  return WEEKDAY_LABELS[index] ?? "";
}
