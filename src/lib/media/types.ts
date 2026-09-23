/**
 * 媒体资源抽象 —— 借鉴 Animeko `datasource/api/.../Media.kt` 的设计。
 *
 * 设计要点（照搬 Animeko 的取舍，理由见 docs/MEDIA.md §1）：
 * - `mediaId` 必须**稳定**且不含请求信息：下载去重、合集复用都依赖它；
 * - `download` 是 sealed 的「如何拿到资源」，而不是一个裸 URL ——
 *   磁力、种子文件、直链、播放页 URL 的后续处理完全不同；
 * - `episodeRange` 让一个资源声明「我覆盖第 1–12 集」，
 *   从而一次查询可供整季复用；
 * - `kind` 区分本地缓存 / 局域网 / 在线，是排序的第一维度。
 *
 * ⚠️ 边界：hit-ani **不托管视频、不提供种子、不做种**。
 * 本模块只描述「资源在哪、怎么访问」，不承载任何视频内容。
 */

/** 资源种类。排序时本地优先于在线。 */
export const MediaSourceKind = {
  Web: "WEB",
  BitTorrent: "BitTorrent",
  LocalCache: "LocalCache",
} as const;

export type MediaSourceKindValue =
  (typeof MediaSourceKind)[keyof typeof MediaSourceKind];

/**
 * 「如何拿到资源」。
 *
 * 对照 Animeko 的 `ResourceLocation`（MagnetLink/HttpTorrentFile/HttpStreamingFile/WebVideo/LocalFile）。
 * 这里保留同一组形态，便于将来对接时直接映射。
 */
export type ResourceLocation =
  /** 磁力链接。hit-ani 自身不解析，仅作为可选项交给外部客户端。 */
  | { type: "magnet"; url: string }
  /** .torrent 文件 URL */
  | { type: "torrent-file"; url: string; sizeBytes?: number }
  /** 可直接播放的流（m3u8 / mp4）。`headers` 用于防盗链透传。 */
  | { type: "http-stream"; url: string; headers?: Record<string, string> }
  /** 播放页 URL，需要进一步解析才能得到视频地址 */
  | { type: "web-video"; url: string; matcher?: WebVideoMatcher }
  /** 本地文件 */
  | { type: "local-file"; path: string };

/** 从播放页 HTML 里提取真实视频地址的规则。 */
export interface WebVideoMatcher {
  /** 匹配嵌套地址（如中间跳转页） */
  matchNestedUrl?: string;
  /** 匹配最终视频地址；支持 `(?<v>...)` 命名分组 */
  matchVideoUrl?: string;
  /** 请求播放页与视频时附带的请求头（防盗链） */
  headers?: Record<string, string>;
}

/** 剧集范围。`single` = 单集，`range` = 连续区间，`season` = 整季未知集数。 */
export type EpisodeRange =
  | { type: "single"; episodeId: number }
  | { type: "range"; start: number; end: number }
  | { type: "season" };

export interface MediaProperties {
  /** 分辨率标签，如 `1080P` / `720P` / `4K`。 */
  resolution?: string;
  /** 字幕语言标识，如 `CHS` / `CHT` / `JPY`。空数组表示无字幕。 */
  subtitleLanguageIds: string[];
  /** 字幕组 / 在线源线路名。 */
  alliance?: string;
  sizeBytes?: number;
}

/** 媒体资源。 */
export interface Media {
  /** 全局唯一且稳定：同一资源多次查询必须返回相同值。 */
  mediaId: string;
  mediaSourceId: string;
  /** 资源的原始页面/条目地址，供用户查看来源。 */
  originalUrl: string;
  download: ResourceLocation;
  /** 覆盖的剧集范围；解析失败为 null。 */
  episodeRange: EpisodeRange | null;
  originalTitle: string;
  /** 发布于（Unix 毫秒），用于「新的在前」排序。 */
  publishedTime: number;
  properties: MediaProperties;
  kind: MediaSourceKindValue;
}

/** 匹配等级。精确匹配始终优先于模糊匹配。 */
export const MatchKind = {
  Exact: "EXACT",
  Fuzzy: "FUZZY",
} as const;

export type MatchKindValue = (typeof MatchKind)[keyof typeof MatchKind];

export interface MediaMatch {
  media: Media;
  matchKind: MatchKindValue;
}

/**
 * 资源是否覆盖指定集。对应 Animeko 的 `EpisodeMatch` 判定。
 * `episodeSort` 是条目内序号，`episodeId` 是 BGM 集 ID。
 */
export function coversEpisode(
  range: EpisodeRange | null,
  episode: { episodeId: number; sort: number },
): boolean {
  if (range === null) return false;
  switch (range.type) {
    case "single":
      return range.episodeId === episode.episodeId;
    case "range":
      return episode.sort >= range.start && episode.sort <= range.end;
    case "season":
      return true;
  }
}

/** 下载代价：本地 < 局域网 < 在线。排序时优先取代价低者。 */
export function downloadCost(kind: MediaSourceKindValue): number {
  if (kind === MediaSourceKind.LocalCache) return 0;
  if (kind === MediaSourceKind.BitTorrent) return 2;
  return 1;
}
