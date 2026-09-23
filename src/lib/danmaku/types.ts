/**
 * 弹幕领域类型。
 *
 * 字段对齐 Animeko 的 `DanmakuInfo` / `DanmakuContent` / `DanmakuLocation`
 * （danmaku/api/src/commonMain/kotlin/DanmakuInfo.kt），
 * 以便未来客户端复用同一套渲染与过滤逻辑。
 *
 * 额外扩了 `schoolId` —— 本校专属维度是 hit-ani 相对 BGM / Animeko 的差异点。
 */

/** 弹幕位置，数值与数据库 `Danmaku.location` 一致。 */
export const DanmakuLocation = {
  Normal: 0,
  Top: 1,
  Bottom: 2,
} as const;

export type DanmakuLocationValue =
  (typeof DanmakuLocation)[keyof typeof DanmakuLocation];

export const DANMAKU_LOCATION_NAMES = ["NORMAL", "TOP", "BOTTOM"] as const;
export type DanmakuLocationName = (typeof DANMAKU_LOCATION_NAMES)[number];

/** 弹幕状态，数值与数据库 `Danmaku.status` 一致。 */
export const DanmakuStatus = {
  Normal: 0,
  Blocked: 1,
  Deleted: 2,
} as const;

/** 弹幕来源。自建为 HitAni；P1 接入 dandanplay 后并列展示。 */
export const DanmakuServiceId = {
  HitAni: "HitAni",
  Dandanplay: "Dandanplay",
} as const;

export type DanmakuServiceIdValue =
  (typeof DanmakuServiceId)[keyof typeof DanmakuServiceId];

/** 单条弹幕的对外形态（wire format）。 */
export interface DanmakuDto {
  id: string;
  episodeId: number;
  serviceId: DanmakuServiceIdValue | string;
  /** 发送者展示名；匿名场景下为占位。 */
  senderId: string;
  senderName: string;
  /** 发送者所属学校，用于前端标注「本校」。 */
  schoolId: string;
  /** 时间轴，毫秒。对应 Animeko 的 playTimeMillis。 */
  playTimeMs: number;
  /** RGB 整数，0xFFFFFF 为白。 */
  color: number;
  text: string;
  /** 0=NORMAL 1=TOP 2=BOTTOM。 */
  location: DanmakuLocationValue;
}

/** 发送弹幕的请求体。 */
export interface DanmakuSendInput {
  episodeId: number;
  playTimeMs: number;
  text: string;
  color?: number;
  location?: DanmakuLocationValue;
}

/** 拉取弹幕的查询条件。 */
export interface DanmakuQuery {
  episodeId: number;
  /** 时间窗起点（毫秒，含）；省略表示不设下限。 */
  fromMs?: number;
  /** 时间窗终点（毫秒，含）；省略表示不设上限。 */
  toMs?: number;
  /** true 时只返回本校弹幕 —— 在 SQL 层用索引命中，不做后置过滤。 */
  schoolOnly?: boolean;
  /** 查看者所属学校；`schoolOnly` 时必填。 */
  schoolId?: string;
  limit?: number;
}

export const DANMAKU_LIMITS = {
  /** 单条弹幕最大字符数（按 Unicode 码点计）。 */
  maxTextLength: 100,
  /** 单次拉取默认条数。 */
  defaultLimit: 2000,
  /** 单次拉取硬上限，防止大房间拖垮服务。 */
  maxLimit: 10000,
  /** 时间窗最大跨度，避免全量扫描。 */
  maxWindowMs: 10 * 60 * 1000,
} as const;
