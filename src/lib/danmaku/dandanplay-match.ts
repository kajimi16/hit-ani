/**
 * BGM 剧集 → dandanplay 剧集 的映射。
 *
 * 为什么需要单独一层：dandanplay 用自己的剧集 ID，与 BGM 的 episodeId 无关。
 * 要拉它的弹幕，必须先把「我们这边的这一集」翻译成「它那边的那一集」。
 *
 * 降级链（照搬 Animeko 的 `DandanplayDanmakuProvider`，见 docs/MEDIA.md §5）：
 *
 *   1. 用 BGM subjectId 直接查 dandanplay 的 bgmtv 映射（**最可靠**）
 *   2. 用条目名与全部别名搜索
 *   3. 剧集级匹配：sort → ep → 集名精确 → Levenshtein 模糊
 *
 * 第 1 步命中率最高，因为它依赖两站之间已有的 ID 对应关系，不涉及标题差异。
 */

import { prisma } from "@/lib/prisma";
import { getEpisodesByBgmtvSubjectId, searchEpisodes } from "./dandanplay";
import { matchEpisode, type CandidateEpisode } from "./matching";

export interface MatchedDandanplayEpisode {
  episodeId: number;
  /** 匹配用的剧集名，便于日志排查 */
  episodeTitle: string;
  /** 匹配到的方式，用于判断可信度 */
  method: string;
}

/** dandanplay 返回的剧集 → 统一的候选结构。 */
function toCandidates(
  animes: { animeTitle: string; episodes?: { episodeId: number; episodeTitle: string; episodeNumber: string }[] }[],
): CandidateEpisode[] {
  const candidates: CandidateEpisode[] = [];
  for (const anime of animes) {
    for (const episode of anime.episodes ?? []) {
      // dandanplay 的 episodeNumber 是字符串，可能含非数字（如 "SP1"）
      const sort = Number.parseInt(episode.episodeNumber, 10);
      candidates.push({
        episodeId: episode.episodeId,
        subjectName: anime.animeTitle,
        episodeName: episode.episodeTitle,
        episodeSort: Number.isFinite(sort) ? sort : null,
      });
    }
  }
  return candidates;
}

/**
 * 找到 BGM 剧集在 dandanplay 上的对应剧集。
 *
 * 返回 null 表示未能匹配 —— 调用方应把它当作「这一集没有外部弹幕」，
 * **不要**退而求其次用模糊结果播别的集的弹幕（那比没有更糟）。
 */
export async function matchDandanplayEpisode(
  subjectId: number,
  bgmEpisodeId: number,
): Promise<MatchedDandanplayEpisode | null> {
  const [subject, episode] = await Promise.all([
    prisma.subject.findUnique({
      where: { id: subjectId },
      select: { name: true, nameCn: true },
    }),
    prisma.episode.findUnique({
      where: { id: bgmEpisodeId },
      select: { sort: true, ep: true, name: true, nameCn: true },
    }),
  ]);
  if (!subject || !episode) return null;

  // BGM 的条目名与中文名都作为别名参与匹配 —— 译名差异是常态
  const aliases = [subject.nameCn, subject.name].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  const request = {
    subjectName: subject.nameCn?.trim() || subject.name,
    subjectAliases: aliases,
    episodeSort: episode.sort,
    episodeEp: episode.ep ?? null,
    episodeName: episode.nameCn?.trim() || episode.name,
  };

  // ---- 第 1 步：bgmtv 直接映射（最可靠）----
  try {
    const direct = await getEpisodesByBgmtvSubjectId(subjectId);
    const candidates = toCandidates([direct.bangumi]);
    if (candidates.length > 0) {
      const result = matchEpisode(request, candidates);
      if (result.episode) {
        return {
          episodeId: result.episode.episodeId,
          episodeTitle: result.episode.episodeName,
          method: `bgmtv映射/${result.method}`,
        };
      }
    }
  } catch {
    // 该条目在 dandanplay 没有映射是常态，继续走搜索
  }

  // ---- 第 2 步：按名称搜索 ----
  for (const name of aliases.slice(0, 2)) {
    try {
      const found = await searchEpisodes(name);
      const candidates = toCandidates(found.animes);
      if (candidates.length === 0) continue;

      const result = matchEpisode(request, candidates);
      if (result.episode) {
        return {
          episodeId: result.episode.episodeId,
          episodeTitle: result.episode.episodeName,
          method: `名称搜索/${result.method}`,
        };
      }
    } catch {
      // 单个名称失败不影响下一个
    }
  }

  return null;
}
