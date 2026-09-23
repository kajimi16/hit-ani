/**
 * Animeko 弹幕格式 → 站内格式 的字段映射。
 *
 * 单独抽成模块的原因：这些映射是**纯函数**，可以脱离数据库与网络测试。
 * 之前把它们写在 `external.ts` 里（那个模块顶层要连 prisma），
 * 导致只能靠「在测试里照抄一遍逻辑」来验证 —— 那种测试改坏了实现也不会失败，
 * 等于没测。
 *
 * 两个映射都踩过坑：
 * - 颜色是带符号 ARGB（`-1` = 白），不剥 alpha 会得到负数颜色，canvas 画不出来
 * - 位置是字符串枚举，与站内的数值枚举不是同一套
 */

import { DanmakuLocation, type DanmakuLocationValue } from "./types";

/**
 * 位置映射。
 *
 * 未知值退回 NORMAL 而非丢弃整条弹幕 —— 位置不对总比看不到好。
 */
export function mapAnimekoLocation(raw: unknown): DanmakuLocationValue {
  switch (raw) {
    case "TOP":
      return DanmakuLocation.Top;
    case "BOTTOM":
      return DanmakuLocation.Bottom;
    default:
      return DanmakuLocation.Normal;
  }
}

/**
 * 颜色映射：带符号 ARGB → RGB。
 *
 * Animeko 用 `.NET` 风格的 32 位整数表示颜色，白色是 `-1`（即 `0xFFFFFFFF`）。
 * 直接拿去当 CSS 颜色会得到负数 —— canvas 上是黑的或干脆不绘制。
 * 非法值回退**白色**而不是 0：0 是黑色，在深色背景上与背景融为一体。
 */
export function mapAnimekoColor(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0xffffff;
  return raw & 0xffffff;
}

/** `{ playTime, color, text, location }` → 站内可用的字段。 */
export interface MappedAnimekoFields {
  playTimeMs: number;
  color: number;
  text: string;
  location: DanmakuLocationValue;
}

/**
 * 映射单条弹幕的内容字段。
 * 返回 null 表示该条不可用（缺文本、时间非法）—— 调用方应跳过。
 */
export function mapAnimekoContent(info: {
  playTime?: unknown;
  color?: unknown;
  text?: unknown;
  location?: unknown;
} | undefined): MappedAnimekoFields | null {
  const text = typeof info?.text === "string" ? info.text.trim() : "";
  if (text.length === 0) return null;

  const playTime = info?.playTime;
  if (typeof playTime !== "number" || !Number.isFinite(playTime) || playTime < 0) return null;

  return {
    playTimeMs: Math.round(playTime),
    color: mapAnimekoColor(info?.color),
    text,
    location: mapAnimekoLocation(info?.location),
  };
}
