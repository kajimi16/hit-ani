/**
 * 外部资源检索服务 —— 把「抓取源」的结果整理成条目页可用的形态。
 *
 * 设计取舍：
 *
 * 1. **结果缓存**。每次打开条目页都去抓第三方站既慢又没礼貌（对方站点会看到
 *    成倍的请求量）。用进程内 TTL 缓存，同一部番短时间内只抓一次。
 *    TTL 取 10 分钟 —— 资源更新以小时计，10 分钟足够新鲜。
 *
 * 2. **不解析直链，只给外站入口**。这是刻意的边界：平台只做「哪里能找到」的索引，
 *    不代理视频字节（见 docs/MEDIA.md §6.4）。用户点击后由浏览器直接访问外站。
 *
 * 3. **单源失败不影响其它源**，并把失败原因带回前端 —— 第三方源必然会有挂掉的时候。
 */

import { prisma } from "@/lib/prisma";
import { extractEpisodeNumber, extractSizeBytes, isTorrentLink } from "./extract";
import { SourceFactory } from "./source-config";
import { listSources, searchAllSources } from "./service";

/** 缓存 TTL。资源更新以小时计，10 分钟足够新鲜。 */
export const RESOURCE_CACHE_TTL_MS = 10 * 60 * 1000;

/** 对外暴露的单条资源。 */
export interface ExternalResource {
  /** 来源名（如「动漫花园」） */
  sourceName: string;
  sourceId: string;
  /** 资源标题（原始，含字幕组/分辨率等信息） */
  title: string;
  /** 外站链接 —— 由用户浏览器直接打开，不经过本平台 */
  url: string;
  /** 从标题解析出的集号；null 表示合集或无法判定 */
  episodeNumber: number | null;
  /** 从标题解析出的体积；null 表示未标注 */
  sizeBytes: number | null;
  /** 发布时间（毫秒）；0 表示未知 */
  publishedTime: number;
  /** 是否种子/磁力链接 */
  isTorrent: boolean;
}

export interface SourceSummary {
  sourceId: string;
  sourceName: string;
  ok: boolean;
  error: string | null;
  count: number;
  /**
   * 该源能否站内播放（需要 web-selector + 视频地址正则）。
   * RSS/BT 源给的是磁力链接，浏览器无法播放 —— 界面据此决定是否显示播放按钮。
   */
  playable: boolean;
}

export interface SubjectResources {
  subjectId: number;
  /** 查询用的关键词 */
  keyword: string;
  resources: ExternalResource[];
  sources: SourceSummary[];
  /** 是否来自缓存 */
  cached: boolean;
  fetchedAt: string;
}

interface CacheEntry {
  value: SubjectResources;
  expiresAt: number;
}

const cache = new Map<number, CacheEntry>();

/** 测试与运维用：清空缓存。 */
export function clearResourceCache(): void {
  cache.clear();
}

/**
 * 检索某条目的外部资源。
 *
 * 关键词用条目的中文名优先（第三方站多以中文名收录），再回退原名。
 * 与弹幕匹配同理：标题差异是常态，别名越多命中率越高。
 */
export async function findSubjectResources(
  subjectId: number,
  options: { forceRefresh?: boolean } = {},
): Promise<SubjectResources> {
  if (!options.forceRefresh) {
    const hit = cache.get(subjectId);
    if (hit && hit.expiresAt > Date.now()) {
      return { ...hit.value, cached: true };
    }
  }

  const subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    select: { name: true, nameCn: true },
  });
  if (!subject) throw new Error("条目尚未缓存到本地，请先打开条目详情页");

  const sources = await listSources(true);
  if (sources.length === 0) {
    const empty: SubjectResources = {
      subjectId,
      keyword: subject.nameCn ?? subject.name,
      resources: [],
      sources: [],
      cached: false,
      fetchedAt: new Date().toISOString(),
    };
    return empty;
  }

  // 中文名优先，回退原名。只用一个关键词 —— 多关键词会把请求量翻倍，
  // 而第三方站的搜索通常已是模糊匹配。
  const keyword = subject.nameCn?.trim() || subject.name;

  const results = await searchAllSources(keyword, { maxResultsPerSource: 30 });

  const resources: ExternalResource[] = [];
  const summaries: SourceSummary[] = [];

  for (const result of results) {
    const collected: ExternalResource[] = [];

    // RSS 源：每条是一个资源
    for (const item of result.feedItems) {
      collected.push({
        sourceId: result.sourceId,
        sourceName: result.sourceName,
        title: item.title,
        url: item.url,
        episodeNumber: extractEpisodeNumber(item.title),
        sizeBytes: item.sizeBytes ?? extractSizeBytes(item.title),
        publishedTime: item.publishedTime,
        isTorrent: isTorrentLink(item.url),
      });
    }

    // web-selector 源：每条是一个条目详情页（点进去才是剧集列表）
    for (const item of result.items) {
      collected.push({
        sourceId: result.sourceId,
        sourceName: result.sourceName,
        title: item.name,
        url: item.url,
        episodeNumber: extractEpisodeNumber(item.name),
        sizeBytes: extractSizeBytes(item.name),
        publishedTime: 0,
        isTorrent: false,
      });
    }

    resources.push(...collected);
    const sourceConfig = sources.find((item) => item.id === result.sourceId);
    summaries.push({
      sourceId: result.sourceId,
      sourceName: result.sourceName,
      ok: result.ok,
      error: result.error,
      count: collected.length,
      playable: Boolean(
        sourceConfig?.factory === SourceFactory.WebSelector &&
          (sourceConfig.config as { videoUrlPattern?: string }).videoUrlPattern,
      ),
    });
  }

  // 排序：能对上集号的按集号升序在前（用户最想找的就是这些），
  // 合集/未知按发布时间降序排在后（新的更可能还有种）。
  resources.sort((a, b) => {
    if (a.episodeNumber !== null && b.episodeNumber !== null) {
      return a.episodeNumber - b.episodeNumber;
    }
    if (a.episodeNumber !== null) return -1;
    if (b.episodeNumber !== null) return 1;
    return b.publishedTime - a.publishedTime;
  });

  const value: SubjectResources = {
    subjectId,
    keyword,
    resources,
    sources: summaries,
    cached: false,
    fetchedAt: new Date().toISOString(),
  };

  cache.set(subjectId, { value, expiresAt: Date.now() + RESOURCE_CACHE_TTL_MS });
  return value;
}

/** 按集号把资源分组，供界面按 BGM 的集展示。 */
export function groupByEpisode(
  resources: readonly ExternalResource[],
): { episodeNumber: number | null; items: ExternalResource[] }[] {
  const byEpisode = new Map<number | null, ExternalResource[]>();
  for (const resource of resources) {
    const list = byEpisode.get(resource.episodeNumber) ?? [];
    list.push(resource);
    byEpisode.set(resource.episodeNumber, list);
  }

  return [...byEpisode.entries()]
    .sort(([a], [b]) => {
      if (a !== null && b !== null) return a - b;
      if (a !== null) return -1;
      if (b !== null) return 1;
      return 0;
    })
    .map(([episodeNumber, items]) => ({ episodeNumber, items }));
}
