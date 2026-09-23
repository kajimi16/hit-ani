/**
 * 番剧/剧集匹配 —— 公共弹幕源的「找对是哪一集」问题。
 *
 * 借鉴 Animeko `danmaku/dandanplay/.../DandanplayDanmakuProvider.kt` 的降级链
 * （docs/MEDIA.md §5），但**把纯算法与网络调用分离**：本模块不含任何 IO，
 * 因此可以在没有 AppId/AppSecret 的情况下完整测试。
 *
 * 匹配为什么难：同一部番在 Bangumi 与 dandanplay 的标题可能完全不同
 * （日文原名 / 中文译名 / 罗马音 / 别名），集数编号也可能差一。
 * 因此需要**逐级降级**，而不是一次搜索定生死。
 */

/** 候选剧集（来自任意弹幕源）。 */
export interface CandidateEpisode {
  /** 源侧剧集 ID */
  episodeId: number;
  /** 所属番剧名（用于相似度） */
  subjectName: string;
  /** 剧集名 */
  episodeName: string;
  /** 在系列中的序号；上游可能给空串 */
  episodeSort: number | null;
}

/** 待匹配的请求（来自本地已缓存的 BGM 数据）。 */
export interface MatchRequest {
  /** BGM 条目名（主名） */
  subjectName: string;
  /** BGM 条目的全部别名 —— 这是提高命中率的关键输入 */
  subjectAliases: string[];
  /** 条目内集序号 */
  episodeSort: number;
  /** 季度内集序号，可能为 null */
  episodeEp: number | null;
  /** 集名 */
  episodeName: string;
}

export const MatchMethod = {
  /** 按 sort/ep 精确命中 */
  ExactNumber: "EXACT_NUMBER",
  /** 集名精确命中 */
  ExactName: "EXACT_NAME",
  /** 番剧名精确 + 集名模糊 */
  SubjectExact: "EXACT_SUBJECT_FUZZY_EPISODE",
  /** 全靠模糊相似度 */
  Fuzzy: "FUZZY",
  /** 未命中 */
  NoMatch: "NO_MATCH",
} as const;

export type MatchMethodValue = (typeof MatchMethod)[keyof typeof MatchMethod];

export interface MatchResult {
  episode: CandidateEpisode | null;
  method: MatchMethodValue;
  /** 模糊匹配时的距离，越小越像；非模糊匹配为 null。 */
  distance: number | null;
}

/**
 * Levenshtein 编辑距离（滚动数组，O(min(m,n)) 空间）。
 *
 * 对齐 Animeko 的做法：**不做归一化、不设阈值**，直接对「番剧名距离 + 集名距离」
 * 求和后取最小。理由是这样在标题长度差异大时更稳定。
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // 让较短的作为列，减少内存
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // 删除
        curr[j - 1] + 1, // 插入
        prev[j - 1] + cost, // 替换
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

/**
 * 归一化标题，用于宽松比较：
 * 去除空白与常见分隔符、统一大小写、全角转半角。
 */
export function normalizeTitle(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～、-〜"'"'」』【】〔〕・ー]/g, "");
}

/** 两个标题是否等价（归一化后相等，或互为前缀）。 */
export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb;
}

/**
 * 给定请求与候选集，选出最匹配的一集。
 *
 * 优先级（严格按序，前一级命中即返回）：
 *  1. `sort` 精确相等
 *  2. `ep` 精确相等
 *  3. 集名精确（含「第N话 <集名>」前缀变体）
 *  4. Levenshtein 最小（番剧名距离 + 集名距离）
 *
 * 第 4 级是否算「命中」由调用方决定 —— 本函数总是返回最近的一条并标注 `Fuzzy`，
 * 因为最终是否接受模糊结果属于产品决策（Animeko 也是分阶段放宽的）。
 */
export function matchEpisode(
  request: MatchRequest,
  candidates: readonly CandidateEpisode[],
): MatchResult {
  if (candidates.length === 0) {
    return { episode: null, method: MatchMethod.NoMatch, distance: null };
  }

  // 1. sort 精确
  const bySort = candidates.find(
    (candidate) => candidate.episodeSort !== null && candidate.episodeSort === request.episodeSort,
  );
  if (bySort) return { episode: bySort, method: MatchMethod.ExactNumber, distance: null };

  // 2. ep 精确（季度内序号）
  if (request.episodeEp !== null) {
    const byEp = candidates.find(
      (candidate) => candidate.episodeSort !== null && candidate.episodeSort === request.episodeEp,
    );
    if (byEp) return { episode: byEp, method: MatchMethod.ExactNumber, distance: null };
  }

  // 3. 集名精确（含「第N话 」前缀变体）
  if (request.episodeName) {
    const withPrefix = buildPrefixedEpisodeName(request);
    const byName = candidates.find(
      (candidate) =>
        titlesMatch(candidate.episodeName, request.episodeName) ||
        (withPrefix !== null && titlesMatch(candidate.episodeName, withPrefix)),
    );
    if (byName) return { episode: byName, method: MatchMethod.ExactName, distance: null };
  }

  // 4. 模糊：番剧名距离 + 集名距离，取最小
  let best: CandidateEpisode | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const subjectDistance = aliasDistance(candidate.subjectName, request);
    const episodeDistance = request.episodeName
      ? levenshteinDistance(candidate.episodeName, request.episodeName)
      : 0;
    const total = subjectDistance + episodeDistance;
    if (total < bestDistance) {
      bestDistance = total;
      best = candidate;
    }
  }

  if (best === null) {
    return { episode: null, method: MatchMethod.NoMatch, distance: null };
  }
  return { episode: best, method: MatchMethod.Fuzzy, distance: bestDistance };
}

/** 与请求的**全部别名**取最小距离 —— 只比主名会漏掉译名差异。 */
function aliasDistance(candidateSubjectName: string, request: MatchRequest): number {
  const names = [request.subjectName, ...request.subjectAliases];
  let best = Number.POSITIVE_INFINITY;
  for (const name of names) {
    const distance = levenshteinDistance(candidateSubjectName, name);
    if (distance < best) best = distance;
  }
  return best;
}

/**
 * 构造「第N话 <集名>」变体。
 * 上游剧集名常带这个前缀，而 BGM 的集名不带，直接比较会全部失配。
 */
export function buildPrefixedEpisodeName(request: MatchRequest): string | null {
  const number = request.episodeEp ?? request.episodeSort;
  if (!request.episodeName || !Number.isFinite(number)) return null;
  return `第${number}话 ${request.episodeName}`;
}

/**
 * 番剧级匹配：在候选番剧里找到与本地条目标题（含全部别名）等价的那个。
 *
 * 对应 Animeko 的「季度列表 + 别名精确匹配」这一步 —— 它比直接用标题搜索准得多，
 * 因为季度列表是有限的封闭集合，可以逐个精确比对。
 */
export function matchSubject<T extends { animeTitle: string }>(
  request: Pick<MatchRequest, "subjectName" | "subjectAliases">,
  candidates: readonly T[],
): T | null {
  const names = [request.subjectName, ...request.subjectAliases];
  for (const candidate of candidates) {
    for (const name of names) {
      if (titlesMatch(candidate.animeTitle, name)) return candidate;
    }
  }
  return null;
}

/** 匹配等级 → 人类可读说明，供 UI 标注「精确 / 模糊」。 */
export function describeMatch(method: MatchMethodValue): string {
  switch (method) {
    case MatchMethod.ExactNumber:
      return "按集数精确匹配";
    case MatchMethod.ExactName:
      return "按集名精确匹配";
    case MatchMethod.SubjectExact:
      return "按番剧名精确匹配";
    case MatchMethod.Fuzzy:
      return "模糊匹配（可能不准）";
    case MatchMethod.NoMatch:
      return "未匹配到";
  }
}
