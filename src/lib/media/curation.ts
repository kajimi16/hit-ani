/**
 * 媒体库选片标准。
 *
 * 本地媒体库的容量有限（外挂硬盘 418G ≈ 350-850 集），必须有所取舍。
 * 本站采用两条标准（部署方可调整）：
 *
 * | 标准 | 依据 | 数据来源 |
 * | --- | --- | --- |
 * | **有人观看过** | 收藏类型为「看过 / 在看」，或有单集观看进度 | 本地库 |
 * | **本季高分** | 当前季度播出且 Bangumi 评分 > 7 | BGM 实时查询 |
 *
 * 第一条是「需求已被证明」：有人真的看过，说明值得放进库。
 * 第二条是「新番补充」：当季作品还没有观看记录，但评分是可用信号。
 *
 * ## 为什么第二条必须走 BGM 实时查询
 *
 * 本地 `Subject` 表只缓存**用户交互过**的条目（导入的收藏 + 访问过的详情页），
 * 因此其中只有个位数的当季番。要覆盖本季高分番，必须直接查 BGM。
 */

/** 季度。1=冬(1-3月) 2=春(4-6月) 3=夏(7-9月) 4=秋(10-12月) */
export const SEASON_START_MONTH = [1, 4, 7, 10] as const;

export interface SeasonRange {
  year: number;
  /** 季度首月 */
  startMonth: number;
  /** 季度末月 */
  endMonth: number;
  /** `YYYY-MM-DD` */
  start: string;
  /** `YYYY-MM-DD` */
  end: string;
  label: string;
}

/**
 * 计算某日期所属的季度范围。
 *
 * 全部按 UTC 计算 —— 服务器时区不同会导致季度边界漂移，
 * 而「本季番」这种概念跨时区讨论时应当一致。
 */
export function seasonOf(date: Date): SeasonRange {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;

  // 找到该月所属季度的首月：1-3→1, 4-6→4, 7-9→7, 10-12→10
  const startMonth = SEASON_START_MONTH[Math.floor((month - 1) / 3)];
  const endMonth = startMonth + 2;

  const pad = (n: number) => String(n).padStart(2, "0");
  /** 该月最后一天（下月 0 号自动回退） */
  const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();

  const seasonName =
    startMonth === 1 ? "冬" : startMonth === 4 ? "春" : startMonth === 7 ? "夏" : "秋";

  return {
    year,
    startMonth,
    endMonth,
    start: `${year}-${pad(startMonth)}-01`,
    end: `${year}-${pad(endMonth)}-${pad(lastDay)}`,
    label: `${year} 年${seasonName}季`,
  };
}

/**
 * 把标题清洗成文件系统安全的名字。
 *
 * 必须处理的目标文件系统是 **NTFS**（外挂硬盘常见）：
 * 禁止 `\ / : * ? " < > |`，且不允许名字以空格或点结尾。
 *
 * 逗号、括号、中日文字符都是合法的，因此保留 —— 过度清洗会让
 * 目录名与 Bangumi 标题对不上，反而不利于人工核对。
 */
export function sanitizeFileName(raw: string, fallback = "untitled"): string {
  const cleaned = raw
    // NTFS 保留字符（`/` 与 `\\` 是路径分隔符，必须换掉）
    .replace(/[\\/:*?"<>|]/g, " ")
    // 控制字符
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // 折叠空白
    .replace(/\s+/g, " ")
    .trim()
    // NTFS 不允许结尾是点或空格
    .replace(/[. ]+$/, "");

  if (cleaned.length === 0) return fallback;
  // 保留一定余量：NTFS 单段上限 255 字符，但过长不利于阅读与工具处理
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
}

/** 选片标准标识。 */
export const CurationReason = {
  /** 有人观看过（本地库有收藏或进度） */
  Watched: "watched",
  /** 本季高分（BGM 评分 > 阈值） */
  SeasonTopRated: "season-top-rated",
} as const;

export type CurationReasonValue =
  (typeof CurationReason)[keyof typeof CurationReason];

/** 入库候选。 */
export interface CurationEntry {
  subjectId: number;
  name: string;
  nameCn: string | null;
  /** Bangumi 评分；null 表示暂无评分 */
  score: number | null;
  /** 总集数；null 表示未知 */
  episodes: number | null;
  airDate: string | null;
  /** 命中的标准（可能同时命中两条） */
  reasons: CurationReasonValue[];
  /** 建议的 Jellyfin 剧集目录名 */
  folderName: string;
}

export interface CurationInput {
  subjectId: number;
  name: string;
  nameCn: string | null;
  score: number | null;
  episodes: number | null;
  airDate: string | null;
}

/**
 * 生成 Jellyfin 的剧集目录名。
 *
 * Jellyfin 靠「标题 (年份)」这种形式识别作品与年份。年份能显著提升匹配率，
 * 尤其是同名不同季的情况 —— 因此只要知道首播年就一定带上。
 *
 * 用中文名优先（库里的人看中文名），回退原名。
 */
export function suggestShowFolder(input: {
  name: string;
  nameCn: string | null;
  airDate: string | null;
}): string {
  const title = sanitizeFileName(input.nameCn?.trim() || input.name);
  if (!input.airDate) return title;

  const year = /^(\d{4})/.exec(input.airDate)?.[1];
  return year ? `${title} (${year})` : title;
}

/**
 * 合并两路候选并去重。
 *
 * 同一部番可能同时命中两条标准（例如「在看」的当季番），
 * 此时 `reasons` 会同时含两项 —— 而不是产生两条重复记录。
 * 保留顺序：先出现的先保留（调用方先传「观看过」的，语义上更确定）。
 */
export function mergeCuration(candidates: readonly CurationInput[]): CurationEntry[] {
  const byId = new Map<number, CurationEntry>();

  for (const item of candidates) {
    const existing = byId.get(item.subjectId);
    if (existing) {
      // 已在表中：补充名称/评分等更完整的信息，并把新标准并进去
      byId.set(item.subjectId, {
        ...existing,
        // 有更完整的字段就用它（BGM 查询的结果通常更全）
        score: existing.score ?? item.score,
        episodes: existing.episodes ?? item.episodes,
        airDate: existing.airDate ?? item.airDate,
        nameCn: existing.nameCn ?? item.nameCn,
      });
      continue;
    }

    byId.set(item.subjectId, {
      subjectId: item.subjectId,
      name: item.name,
      nameCn: item.nameCn,
      score: item.score,
      episodes: item.episodes,
      airDate: item.airDate,
      reasons: [],
      folderName: suggestShowFolder(item),
    });
  }

  return [...byId.values()];
}

/**
 * 标记某条候选命中了哪个标准。
 * 与 `mergeCuration` 分开，是因为「命中哪条标准」由调用方（查询层）决定，
 * 而合并逻辑不该关心数据是怎么查出来的。
 */
export function withReason(
  entries: readonly CurationEntry[],
  subjectIds: ReadonlySet<number>,
  reason: CurationReasonValue,
): CurationEntry[] {
  return entries.map((entry) =>
    subjectIds.has(entry.subjectId) && !entry.reasons.includes(reason)
      ? { ...entry, reasons: [...entry.reasons, reason] }
      : entry,
  );
}

/** 估算所需空间（按每集平均体积）。 */
export function estimateStorage(
  entries: readonly CurationEntry[],
  mbPerEpisode: number,
): { totalEpisodes: number; totalGb: number } {
  const totalEpisodes = entries.reduce((sum, entry) => sum + (entry.episodes ?? 0), 0);
  return {
    totalEpisodes,
    totalGb: Math.round(((totalEpisodes * mbPerEpisode) / 1024) * 10) / 10,
  };
}

/** 按评分降序、评分相同按集数升序 —— 优先收录高分且体量小的。 */
export function sortForAcquisition(entries: readonly CurationEntry[]): CurationEntry[] {
  return [...entries].sort((a, b) => {
    const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return (a.episodes ?? 0) - (b.episodes ?? 0);
  });
}
