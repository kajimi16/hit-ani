/**
 * 条目 ID 的段位约定 —— **单一来源**。
 *
 * 真实 BGM 条目 ID 是六位数（如 493016），到不了 80 万。因此
 * `id >= STUB_SUBJECT_ID_MIN` 可以安全地判定「这条是测试桩」。
 *
 * ## 为什么必须只写一处
 *
 * 这个常量曾经只活在 `scripts/import-check.ts` 里，于是：
 *
 * - 清理范围按「本次写了哪一段」算 → 基址从 900000 改成 800000 后，
 *   **旧的桩再也没人清**，15 条 `rank` 全为 1 的桩条目霸占了排行榜榜首；
 * - 排行榜、探索页各自写一遍 `800_000` 字面量 → 迟早有一处忘了跟着改。
 *
 * 现在**桩的写入、桩的清理、所有读路径的过滤**都从这里取。
 */

/** 桩条目 ID 下界（含）。 */
export const STUB_SUBJECT_ID_MIN = 800_000;

/**
 * 桩条目 ID 上界（**不含**）。留足余量：换基址时清理范围不用跟着改，
 * 否则又会留下清不掉的孤儿。
 */
export const STUB_SUBJECT_ID_MAX = 1_000_000;

/** 该条目 ID 是否属于测试桩段。 */
export function isStubSubjectId(id: number): boolean {
  return id >= STUB_SUBJECT_ID_MIN;
}

/** 只保留真实条目的 where 条件 —— 拼进 `prisma.subject.findMany` 的 `where`。 */
export const REAL_SUBJECT_ID_FILTER = { lt: STUB_SUBJECT_ID_MIN } as const;
