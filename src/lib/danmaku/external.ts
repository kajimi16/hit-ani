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
 *
 * ## 量级设防
 *
 * 实测 dandanplay 单集可达 **4900+ 条**（约 1 MB）。若不设防：
 * - 浏览器要渲染几千个 DOM 节点
 * - 响应体 1 MB 起，移动网络下明显卡顿
 * - 内存缓存按集累积且无上限
 *
 * 因此有三道限制：单源条数上限、合并后总量上限、缓存条数上限。
 * 截断时把真实总数带回（`totalAvailable`），界面可以如实告知
 * 「本集共 N 条，已加载 M 条」而不是假装只有 M 条。
 */

import { mapAnimekoContent } from "./animeko-mapping";
import { getComments, isConfigured as dandanplayConfigured, parseComments } from "./dandanplay";
import { readDanmakuCache, writeDanmakuCache } from "./cache-repository";
import { matchDandanplayEpisode } from "./dandanplay-match";
import { TtlLruCache } from "./lru-cache";
import { isBlocked } from "./filter";
import type { DanmakuDto } from "./types";

/**
 * 持久化缓存的 TTL。
 *
 * 对齐 dandanplay 官方的缓存建议（§10）：「绝大部分数据都不会频繁变动…
 * 可以根据 ID 等条件适当缓存一段时间（如 2-6 小时）」。
 *
 * 早先取 5 分钟，远低于这个区间 —— 等于白白重复回源，
 * 而 dandanplay 明确会对调用量大的应用限流。
 * 取 6 小时（区间上沿）：当季番的新弹幕最多延迟 6 小时出现，
 * 对「看番」场景可接受，而上游请求量降到 1/72。
 */
export const EXTERNAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 内存缓存的 TTL：进程内只挡高频重复请求，短一些无妨。 */
export const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000;
/** 单次拉取超时。 */
const FETCH_TIMEOUT_MS = 12_000;

/**
 * 单个源返回的弹幕上限。
 *
 * 弹幕是**按时间轴消费**的，整集几千条里用户当下只看得见附近几百条。
 * 上限取 3000：足以覆盖正常观看窗口，又能挡住 4900 条那种极端情况。
 */
export const MAX_DANMAKU_PER_SOURCE = 3000;

/**
 * 缓存的最大集数（LRU 淘汰）。
 *
 * 0.92 MB/集 —— 不设上限时，网关这个**常驻进程**会随访问过的集数持续增长，
 * 跑几周就是几百 MB。取 40 集约 37 MB，对 2C4G 的部署是可接受的上限。
 */
export const MAX_CACHED_EPISODES = 40;

/** Animeko 弹幕服务。 */
export const ANIMEKO_DANMAKU_API = "https://api.animeko.org";

/** 弹幕来源标识，与 `DanmakuServiceId` 对应。 */
export const ExternalService = {
  Animeko: "Animeko",
  Dandanplay: "Dandanplay",
} as const;

export type ExternalServiceValue = (typeof ExternalService)[keyof typeof ExternalService];

/**
 * 单个源的返回结果。
 *
 * `total` 是**截断前**的真实条数 —— 必须单独带出来。
 * 早先的实现只返回截断后的数组，于是「共 N 条」里的 N 变成了上限值，
 * 截断日志也永不触发（因为比较的两个数都是截断后的）。
 */
export interface SourceDanmaku {
  items: DanmakuDto[];
  /** 截断前的真实总数 */
  total: number;
}

/**
 * 弹幕缓存，带 TTL 与 LRU 淘汰。
 *
 * 缓存**完整结果**（含真实总数），否则命中缓存时「共 N 条」这个信息就丢了 ——
 * 用户会从「共 4909 条，已显示前 3000 条」突然变成「共 3000 条」。
 */
const cache = new TtlLruCache<SourceDanmaku>({
  maxSize: MAX_CACHED_EPISODES,
  ttlMs: MEMORY_CACHE_TTL_MS,
});

/**
 * 两级缓存的统一读取：内存 → 数据库 → null（调用方回源）。
 *
 * 数据库那层是「重启不丢」的关键；内存那层只是挡高频重复。
 */
async function readThrough(
  service: string,
  episodeId: number,
): Promise<SourceDanmaku | null> {
  const memory = cache.get(cacheKey(service, episodeId));
  if (memory) return memory;

  try {
    const persisted = await readDanmakuCache(service, episodeId, EXTERNAL_CACHE_TTL_MS);
    if (!persisted) return null;
    const value: SourceDanmaku = {
      items: persisted.items as DanmakuDto[],
      total: persisted.total,
    };
    // 回填内存层，后续请求不再打数据库
    cache.set(cacheKey(service, episodeId), value);
    return value;
  } catch (error) {
    // 缓存读失败不该让整集弹幕不可用 —— 退化为「直接回源」
    console.warn(
      `[external-danmaku] 读持久化缓存失败（${service}:${episodeId}）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** 同时写两级缓存。持久化失败不影响本次返回。 */
async function writeThrough(
  service: string,
  episodeId: number,
  value: SourceDanmaku,
): Promise<void> {
  cache.set(cacheKey(service, episodeId), value);
  try {
    await writeDanmakuCache(service, episodeId, {
      items: value.items,
      total: value.total,
    });
  } catch (error) {
    console.warn(
      `[external-danmaku] 写持久化缓存失败（${service}:${episodeId}）：` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 测试与运维用：清空缓存。 */
export function clearExternalCache(): void {
  cache.clear();
}

/** 当前缓存的集数（运维观察用）。 */
export function externalCacheSize(): number {
  return cache.size;
}

/** 累计淘汰次数；持续增长说明容量上限偏小。 */
export function externalCacheEvictions(): number {
  return cache.evictionCount;
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
export async function fetchAnimekoDanmaku(episodeId: number): Promise<SourceDanmaku> {
  const cached = await readThrough(ExternalService.Animeko, episodeId);
  if (cached) return cached;

  const response = await fetch(`${ANIMEKO_DANMAKU_API}/v1/danmaku/${episodeId}`, {
    headers: { Accept: "application/json", "User-Agent": "hit-ani/0.1" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cache: "no-store",
  });

  // 该集没有弹幕时服务端也可能返回 404 —— 视为「空」而不是错误。
  // 空结果也缓存：否则每次访问都要回源确认一次「确实没有」。
  if (response.status === 404) {
    const empty: SourceDanmaku = { items: [], total: 0 };
    await writeThrough(ExternalService.Animeko, episodeId, empty);
    return empty;
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

  // ★ 先在截断**之前**记下真实条数 —— 否则「共 N 条」会变成上限值
  const result: SourceDanmaku = {
    total: items.length,
    items: items.slice(0, MAX_DANMAKU_PER_SOURCE),
  };
  await writeThrough(ExternalService.Animeko, episodeId, result);
  return result;
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
}): Promise<SourceDanmaku> {
  if (!dandanplayConfigured()) return { items: [], total: 0 };

  const cachedDdp = await readThrough(ExternalService.Dandanplay, params.bgmEpisodeId);
  if (cachedDdp) return cachedDdp;

  const episode = await matchDandanplayEpisode(params.subjectId, params.bgmEpisodeId);
  if (!episode) {
    // 「匹配不到」也缓存 —— 匹配要查库、还可能打上游搜索接口，
    // 不缓存会让冷门番每次访问都白跑一遍匹配链。
    const empty: SourceDanmaku = { items: [], total: 0 };
    await writeThrough(ExternalService.Dandanplay, params.bgmEpisodeId, empty);
    return empty;
  }

  const response = await getComments(episode.episodeId);
  const items = parseComments(response, params.bgmEpisodeId).filter((d) => !isBlocked(d.text));

  items.sort((a, b) => a.playTimeMs - b.playTimeMs);

  // 实测单集可达 4900+ 条（约 1 MB）。同样先记真实条数再截断。
  const result: SourceDanmaku = {
    total: items.length,
    items: items.slice(0, MAX_DANMAKU_PER_SOURCE),
  };
  await writeThrough(ExternalService.Dandanplay, params.bgmEpisodeId, result);
  return result;
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

export interface ExternalFetchResult {
  items: DanmakuDto[];
  /** 各源的状态，便于界面提示「为什么没有外部弹幕」 */
  sources: { service: string; ok: boolean; count: number; error: string | null }[];
  /** 该集外部弹幕的**总数**（截取前）。用于告知用户「还有多少条没显示」 */
  totalAvailable: number;
}

/**
 * 拉取全部已启用的外部源并合并。
 *
 * **单源失败不阻断其它源** —— 第三方服务必然会有挂掉的时候，
 * 一个源挂了不该让整集弹幕消失。
 *
 * `maxItems` 是**合并后**的总量上限（默认 3000）。超出的部分按时间轴截断 ——
 * 保留最早的那一段。对「看番」而言开头总是会看的，而后段可能直接跳过。
 */
export async function fetchExternalDanmaku(params: {
  episodeId: number;
  subjectId?: number;
  /** 合并后的总量上限；单源已各自限流，这里是最后一道闸 */
  maxItems?: number;
}): Promise<ExternalFetchResult> {
  const sources: ExternalFetchResult["sources"] = [];
  const items: DanmakuDto[] = [];

  const tasks: { service: string; run: () => Promise<SourceDanmaku> }[] = [
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

  /** 截断前的真实条数之和 —— 用于告知「本集共 N 条」 */
  let realTotal = 0;

  settled.forEach((result, index) => {
    const service = tasks[index].service;
    if (result.status === "fulfilled") {
      items.push(...result.value.items);
      // 用**真实总数**，不是截断后的长度
      realTotal += result.value.total;
      sources.push({ service, ok: true, count: result.value.items.length, error: null });
    } else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
      sources.push({ service, ok: false, count: 0, error });
      console.warn(`[external-danmaku] ${service} 拉取失败：${error}`);
    }
  });

  // 按时间轴排序后截断 —— 保证截掉的是「后段」而不是随机砍掉某一段
  items.sort((a, b) => a.playTimeMs - b.playTimeMs || (a.id < b.id ? -1 : 1));

  const cap = params.maxItems ?? MAX_DANMAKU_PER_SOURCE;
  const capped = items.length > cap ? items.slice(0, cap) : items;

  // 现在这个判断才有意义：两边是真总数与上限的比较，
  // 而不是「截断后的长度 vs 上限」（那样永远为 false）。
  if (realTotal > cap) {
    console.log(
      `[external-danmaku] episode=${params.episodeId} 共 ${realTotal} 条，` +
        `按上限返回前 ${capped.length} 条`,
    );
  }

  return { items: capped, sources, totalAvailable: realTotal };
}
