/**
 * 外部弹幕源 —— 把 Animeko 与 dandanplay 的弹幕并入站内。
 *
 * 两个源的定位完全不同，都需要：
 *
 * | 源 | 凭据 | 实测特征 |
 * | --- | --- | --- |
 * | Animeko 自建（api.animeko.org） | **无需授权** | 约 50% 的集有弹幕，但每条仅个位数 |
 * | dandanplay | 需 AppId/AppSecret | 聚合 B站/AcFun/巴哈/Tucao，量最大 |
 *
 * ## 设计取舍
 *
 * **不落库**。外部弹幕不是我们的内容：
 * - 不该占用本地存储（一部番几十集 × 每集数千条）
 * - 不该进本地审核队列（我们无权处置）
 * - 源方更新后应立刻反映，而不是等同步任务
 *
 * 因此**实时拉取 + 内存缓存**，并在展示前过一遍站内屏蔽词 ——
 * 它是要显示给我们用户看的，过滤责任仍在我们。
 *
 * `schoolId` 置空串：外部弹幕不属于任何学校，「只看本校」自然把它们排除在外。
 */

import { mapAnimekoContent } from "./animeko-mapping";
import { getComments, isConfigured as dandanplayConfigured, parseComments } from "./dandanplay";
import { matchDandanplayEpisode } from "./dandanplay-match";
import { isBlocked } from "./filter";
import type { DanmakuDto } from "./types";

/** 缓存 TTL：弹幕会持续新增，但对同一集反复拉取没有意义。 */
export const EXTERNAL_CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次拉取超时。 */
const FETCH_TIMEOUT_MS = 12_000;

/** Animeko 弹幕服务。 */
export const ANIMEKO_DANMAKU_API = "https://api.animeko.org";

/** 弹幕来源标识，与 `DanmakuServiceId` 对应。 */
export const ExternalService = {
  Animeko: "Animeko",
  Dandanplay: "Dandanplay",
} as const;

export type ExternalServiceValue = (typeof ExternalService)[keyof typeof ExternalService];

interface CacheEntry {
  value: DanmakuDto[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** 测试与运维用：清空缓存。 */
export function clearExternalCache(): void {
  cache.clear();
}

function cacheKey(service: string, episodeId: number): string {
  return `${service}:${episodeId}`;
}

/* ------------------------------------------------------------------ *
 * Animeko 自建服务
 * ------------------------------------------------------------------ */

interface AnimekoDanmakuEntry {
  id?: string;
  senderId?: string;
  danmakuInfo?: {
    playTime?: number;
    color?: number;
    text?: string;
    location?: string;
  };
}

/**
 * 拉取 Animeko 的弹幕。
 *
 * 该接口**无需授权**（实测 200），且直接用 BGM 的 episodeId ——
 * 这正是 Animeko 的设计：它本身就以 Bangumi 的条目/剧集体系为准。
 * 因此不需要任何 ID 映射，是本项目成本最低的外部弹幕源。
 */
export async function fetchAnimekoDanmaku(episodeId: number): Promise<DanmakuDto[]> {
  const key = cacheKey(ExternalService.Animeko, episodeId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const response = await fetch(`${ANIMEKO_DANMAKU_API}/v1/danmaku/${episodeId}`, {
    headers: { Accept: "application/json", "User-Agent": "hit-ani/0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });

  // 该集没有弹幕时服务端也可能返回 404 —— 视为「空」而不是错误
  if (response.status === 404) {
    cache.set(key, { value: [], expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS });
    return [];
  }
  if (!response.ok) {
    throw new Error(`Animeko 弹幕服务返回 ${response.status}`);
  }

  const body = (await response.json()) as { danmakuList?: AnimekoDanmakuEntry[] };
  const list = body.danmakuList ?? [];

  const items: DanmakuDto[] = [];
  for (const entry of list) {
    const mapped = mapAnimekoContent(entry.danmakuInfo);
    if (!mapped) continue;
    // 站内屏蔽词对外部弹幕同样生效 —— 它显示在我们的页面上
    if (isBlocked(mapped.text)) continue;

    items.push({
      id: `ani-${entry.id ?? `${episodeId}-${mapped.playTimeMs}-${items.length}`}`,
      episodeId,
      serviceId: ExternalService.Animeko,
      senderId: entry.senderId ?? "animeko",
      senderName: "Animeko",
      // 外部弹幕无学校归属 —— 「只看本校」会自然排除它们
      schoolId: "",
      ...mapped,
    });
  }

  items.sort((a, b) => a.playTimeMs - b.playTimeMs);
  cache.set(key, { value: items, expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS });
  return items;
}

/* ------------------------------------------------------------------ *
 * dandanplay
 * ------------------------------------------------------------------ */

/**
 * 拉取 dandanplay 的弹幕。
 *
 * 比 Animeko 麻烦：dandanplay 用自己的剧集 ID，需要先把 BGM 的
 * episodeId 映射过去。映射链见 `dandanplay.ts` 与 `matching.ts`。
 *
 * 未配置凭据时**静默跳过**（返回空数组）而不是报错 ——
 * 部署方可能只想要校内弹幕，不该因此看到满屏错误。
 */
export async function fetchDandanplayDanmaku(params: {
  bgmEpisodeId: number;
  subjectId: number;
}): Promise<DanmakuDto[]> {
  if (!dandanplayConfigured()) return [];

  const key = cacheKey(ExternalService.Dandanplay, params.bgmEpisodeId);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const episode = await matchDandanplayEpisode(params.subjectId, params.bgmEpisodeId);
  if (!episode) {
    cache.set(key, { value: [], expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS });
    return [];
  }

  const response = await getComments(episode.episodeId);
  const items = parseComments(response, params.bgmEpisodeId).filter((d) => !isBlocked(d.text));

  items.sort((a, b) => a.playTimeMs - b.playTimeMs);
  cache.set(key, { value: items, expiresAt: Date.now() + EXTERNAL_CACHE_TTL_MS });
  return items;
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

export interface ExternalFetchResult {
  items: DanmakuDto[];
  /** 各源的状态，便于界面提示「为什么没有外部弹幕」 */
  sources: { service: string; ok: boolean; count: number; error: string | null }[];
}

/**
 * 拉取全部已启用的外部源并合并。
 *
 * **单源失败不阻断其它源** —— 第三方服务必然会有挂掉的时候，
 * 一个源挂了不该让整集弹幕消失。
 */
export async function fetchExternalDanmaku(params: {
  episodeId: number;
  subjectId?: number;
}): Promise<ExternalFetchResult> {
  const sources: ExternalFetchResult["sources"] = [];
  const items: DanmakuDto[] = [];

  const tasks: { service: string; run: () => Promise<DanmakuDto[]> }[] = [
    {
      service: ExternalService.Animeko,
      run: () => fetchAnimekoDanmaku(params.episodeId),
    },
  ];
  if (params.subjectId !== undefined) {
    tasks.push({
      service: ExternalService.Dandanplay,
      run: () =>
        fetchDandanplayDanmaku({
          bgmEpisodeId: params.episodeId,
          subjectId: params.subjectId!,
        }),
    });
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.run()));

  settled.forEach((result, index) => {
    const service = tasks[index].service;
    if (result.status === "fulfilled") {
      items.push(...result.value);
      sources.push({ service, ok: true, count: result.value.length, error: null });
    } else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      sources.push({ service, ok: false, count: 0, error });
      console.warn(`[external-danmaku] ${service} 拉取失败：${error}`);
    }
  });

  return { items, sources };
}
