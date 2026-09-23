/**
 * 弹幕纯逻辑层 —— 不触碰数据库、网络或 DOM，便于单测。
 *
 * 与 Animeko 的分工一致：服务端只管存取与过滤，轨道排布由渲染侧决定。
 * 这里把轨道排布算法也做成纯函数，方便 Web 渲染层与未来客户端共用。
 */

import {
  DANMAKU_LIMITS,
  DanmakuLocation,
  type DanmakuDto,
  type DanmakuLocationValue,
  type DanmakuQuery,
  type DanmakuSendInput,
} from "./types";

export interface DanmakuValidationError {
  field: keyof DanmakuSendInput | "general";
  message: string;
}

/** 归一化文本：折叠空白、去首尾、剥离零宽字符（防排版注入）。 */
export function sanitizeDanmakuText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 按 Unicode 码点计数，避免 emoji 被算作 2 个字符。 */
export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * 校验发送请求。返回空数组表示合法。
 * 不在服务端做敏感词判定（那是审核层职责），只管结构合法性。
 */
export function validateSendInput(input: DanmakuSendInput): DanmakuValidationError[] {
  const errors: DanmakuValidationError[] = [];

  if (!Number.isInteger(input.episodeId) || input.episodeId <= 0) {
    errors.push({ field: "episodeId", message: "episodeId 必须为正整数" });
  }

  if (!Number.isFinite(input.playTimeMs) || input.playTimeMs < 0) {
    errors.push({ field: "playTimeMs", message: "playTimeMs 必须为非负数" });
  }

  const text = sanitizeDanmakuText(input.text ?? "");
  if (text.length === 0) {
    errors.push({ field: "text", message: "弹幕内容不能为空" });
  } else if (countCodePoints(text) > DANMAKU_LIMITS.maxTextLength) {
    errors.push({
      field: "text",
      message: `弹幕内容不能超过 ${DANMAKU_LIMITS.maxTextLength} 个字符`,
    });
  }

  if (input.color !== undefined) {
    if (!Number.isInteger(input.color) || input.color < 0 || input.color > 0xffffff) {
      errors.push({ field: "color", message: "color 必须是 0x000000–0xFFFFFF 的整数" });
    }
  }

  if (input.location !== undefined) {
    const valid: number[] = [
      DanmakuLocation.Normal,
      DanmakuLocation.Top,
      DanmakuLocation.Bottom,
    ];
    if (!valid.includes(input.location)) {
      errors.push({ field: "location", message: "location 只能是 0/1/2" });
    }
  }

  return errors;
}

/** 归一化拉取条件：夹紧 limit、限制时间窗跨度、保证窗口有序。 */
export function normalizeQuery(query: DanmakuQuery): Required<
  Pick<DanmakuQuery, "episodeId" | "limit">
> &
  DanmakuQuery {
  const limit = Math.min(
    Math.max(Math.trunc(query.limit ?? DANMAKU_LIMITS.defaultLimit), 1),
    DANMAKU_LIMITS.maxLimit,
  );

  let fromMs = query.fromMs;
  let toMs = query.toMs;

  if (fromMs !== undefined && fromMs < 0) fromMs = 0;
  if (toMs !== undefined && fromMs !== undefined && toMs < fromMs) {
    [fromMs, toMs] = [toMs, fromMs];
  }
  if (fromMs !== undefined && toMs !== undefined && toMs - fromMs > DANMAKU_LIMITS.maxWindowMs) {
    toMs = fromMs + DANMAKU_LIMITS.maxWindowMs;
  }
  if (query.schoolOnly && !query.schoolId) {
    throw new Error("schoolOnly 需要同时提供 schoolId");
  }

  return { ...query, fromMs, toMs, limit };
}

/**
 * 时间窗切片。用于测试与内存态回填（例如 WS 房间内新加入者补齐首屏）。
 * `fromMs`/`toMs` 均为闭区间。
 */
export function sliceByTimeWindow(
  danmakus: readonly DanmakuDto[],
  fromMs?: number,
  toMs?: number,
): DanmakuDto[] {
  return danmakus.filter(
    (d) =>
      (fromMs === undefined || d.playTimeMs >= fromMs) &&
      (toMs === undefined || d.playTimeMs <= toMs),
  );
}

/** 校内筛选。服务端已用索引实现，这里保留纯函数版本供客户端/测试使用。 */
export function filterBySchool(
  danmakus: readonly DanmakuDto[],
  schoolId: string,
): DanmakuDto[] {
  return danmakus.filter((d) => d.schoolId === schoolId);
}

/** 排序：时间轴升序，同刻按 id 稳定排序，保证各端渲染顺序一致。 */
export function sortByPlayTime(danmakus: readonly DanmakuDto[]): DanmakuDto[] {
  return [...danmakus].sort(
    (a, b) => a.playTimeMs - b.playTimeMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export interface TrackAssignment {
  danmaku: DanmakuDto;
  track: number;
}

export interface TrackAllocationOptions {
  /** 可见轨道数（画面高度 / 行高）。 */
  trackCount: number;
  /** 视口宽度，像素。 */
  viewportWidth: number;
  /** 平均字符宽度，像素。 */
  charWidth?: number;
  /** 滚动弹幕横向速度，像素/毫秒。 */
  speedPxPerMs?: number;
}

const DEFAULT_CHAR_WIDTH = 16;
const DEFAULT_SPEED_PX_PER_MS = 0.18;
/** 固定弹幕滞留时长。 */
const FIXED_DURATION_MS = 4000;

/**
 * 轨道分配：贪心地把每条弹幕放到最早空出的轨道上。
 *
 * - NORMAL（滚动）占用轨道时长为「完全滑出屏幕」所需时间；
 * - TOP / BOTTOM 各自独立占位，滞留固定时长；
 * - 分配不到轨道时下沉到最后一条轨道（宁可重叠也不丢弹幕）。
 *
 * 纯函数，输入顺序不影响结果（内部先按时间排序）。
 */
export function allocateTracks(
  danmakus: readonly DanmakuDto[],
  options: TrackAllocationOptions,
): TrackAssignment[] {
  const {
    trackCount,
    viewportWidth,
    charWidth = DEFAULT_CHAR_WIDTH,
    speedPxPerMs = DEFAULT_SPEED_PX_PER_MS,
  } = options;

  if (trackCount <= 0) return [];

  const normalFreeAt = new Array<number>(trackCount).fill(Number.NEGATIVE_INFINITY);
  const topFreeAt: number[] = [];
  const bottomFreeAt: number[] = [];

  const result: TrackAssignment[] = [];

  for (const danmaku of sortByPlayTime(danmakus)) {
    const width = countCodePoints(danmaku.text) * charWidth;
    const t = danmaku.playTimeMs;

    if (danmaku.location === DanmakuLocation.Normal) {
      // 完全进入 + 完全滑出 的总占用时长
      const occupyMs = (width + viewportWidth) / speedPxPerMs;
      let track = normalFreeAt.findIndex((free) => free <= t);
      if (track === -1) {
        const earliest = Math.min(...normalFreeAt);
        track = normalFreeAt.indexOf(earliest);
      }
      normalFreeAt[track] = t + occupyMs;
      result.push({ danmaku, track });
      continue;
    }

    const freeAt = danmaku.location === DanmakuLocation.Top ? topFreeAt : bottomFreeAt;
    let track = freeAt.findIndex((free) => free <= t);
    if (track === -1) track = freeAt.length;
    freeAt[track] = t + FIXED_DURATION_MS;
    result.push({ danmaku, track });
  }

  return result;
}

/** 供渲染层使用的派生统计。 */
export function summarize(danmakus: readonly DanmakuDto[]) {
  let normal = 0;
  let top = 0;
  let bottom = 0;
  const senders = new Set<string>();
  for (const d of danmakus) {
    if (d.location === DanmakuLocation.Top) top += 1;
    else if (d.location === DanmakuLocation.Bottom) bottom += 1;
    else normal += 1;
    senders.add(d.senderId);
  }
  return { total: danmakus.length, normal, top, bottom, uniqueSenders: senders.size };
}

/** 位置名 ↔ 数值互转，用于 Animeko 风格的 wire format。 */
export function locationToName(location: DanmakuLocationValue): "NORMAL" | "TOP" | "BOTTOM" {
  return location === DanmakuLocation.Top
    ? "TOP"
    : location === DanmakuLocation.Bottom
      ? "BOTTOM"
      : "NORMAL";
}
