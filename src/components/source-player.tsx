"use client";

import { useCallback, useEffect, useState } from "react";
import VideoPlayer from "@/components/video-player";

interface Episode {
  name: string;
  url: string;
}

interface Props {
  /** BGM 的剧集，用于把外部源的集数按序号对齐到弹幕 */
  bgmEpisodes: { id: number; sort: number; ep: number | null }[];
  sourceId: string;
  sourceName: string;
  /** 该源上的条目详情页 */
  detailUrl: string;
  canInteract: boolean;
  onClose: () => void;
}

/**
 * 从外部源解析出视频并在站内播放。
 *
 * 数据流：
 *   条目页 → 剧集列表 → 播放页 → 视频直链 → `<video>` 拉流
 *
 * ⚠️ 关键架构点：**只有前四步的 HTML 抓取经过本服务**（索引行为），
 * 第五步的视频字节由用户的浏览器直连 CDN —— 平台不代理、不转码，
 * 因此没有带宽成本（校内带宽不足是选这条路的根本原因）。
 *
 * 实测验证：解析出的 m3u8 地址无需 Referer 即可访问，
 * 且浏览器能用 hls.js 直接播放（Chrome 不原生支持 HLS）。
 */
export default function SourcePlayer({
  bgmEpisodes,
  sourceId,
  sourceName,
  detailUrl,
  canInteract,
  onClose,
}: Props) {
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [playing, setPlaying] = useState<{ name: string; url: string; episodeNumber: number | null } | null>(null);
  /** 每集的解析状态：解析中 / 失败原因 */
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadEpisodes = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/media/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "episodes", sourceId, url: detailUrl }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        items?: Episode[];
        error?: string;
        diagnostics?: { matchedElements: number };
      };
      if (!body.ok) {
        throw new Error(
          body.error ??
            `未解析出剧集（选择器命中 ${body.diagnostics?.matchedElements ?? 0} 个元素）`,
        );
      }
      setEpisodes(body.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setEpisodes([]);
    }
  }, [sourceId, detailUrl]);

  useEffect(() => {
    void loadEpisodes();
  }, [loadEpisodes]);

  /** 从剧集名解析集号，用于对齐 BGM 的弹幕。 */
  const episodeNumberOf = (name: string): number | null => {
    const match = /第\s*(\d{1,4})\s*[话話集]/.exec(name);
    return match ? Number(match[1]) : null;
  };

  const play = async (episode: Episode) => {
    const episodeNumber = episodeNumberOf(episode.name);
    setResolving(episode.url);
    setError(null);
    try {
      const response = await fetch("/api/media/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", sourceId, url: episode.url }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        videoUrl?: string | null;
        error?: string;
        trail?: string[];
      };
      if (!body.ok || !body.videoUrl) {
        throw new Error(body.error ?? "未能解析出视频地址");
      }
      setPlaying({ name: episode.name, url: body.videoUrl, episodeNumber });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(null);
    }
  };

  /**
   * 把外部源的集号对齐到 BGM 的 episodeId。
   *
   * 对齐不上时返回 null —— 播放器会禁用弹幕，而不是把弹幕挂到错误的集上。
   */
  const bgmEpisodeId =
    playing?.episodeNumber === null || playing === null
      ? null
      : (bgmEpisodes.find((e) => e.ep === playing.episodeNumber)?.id ??
        bgmEpisodes.find((e) => e.sort === playing.episodeNumber)?.id ??
        null);

  return (
    <div className="space-y-4 rounded border border-sky-900 bg-sky-950/20 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-sky-200">站内播放 · {sourceName}</span>
        <span className="text-xs text-neutral-500">
          视频由来源站 CDN 直连你的浏览器，不经过本平台
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          关闭播放器
        </button>
      </div>

      {playing && (
        <VideoPlayer
          key={playing.url}
          episodeId={bgmEpisodeId}
          title={playing.name}
          streamUrl={playing.url}
          canInteract={canInteract}
        />
      )}

      <div className="space-y-2">
        <p className="text-xs text-neutral-400">
          {episodes === null
            ? "正在读取剧集列表…"
            : episodes.length === 0
              ? "没有解析出剧集"
              : `${episodes.length} 集，点击播放（解析需要几秒）`}
        </p>

        {episodes !== null && episodes.length > 0 && (
          <ul className="grid max-h-64 gap-1 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
            {episodes.map((episode) => {
              const busy = resolving === episode.url;
              const active = playing?.url !== undefined && resolving === null && playing.name === episode.name;
              return (
                <li key={episode.url}>
                  <button
                    type="button"
                    onClick={() => void play(episode)}
                    disabled={resolving !== null}
                    className={`w-full rounded border px-2 py-1.5 text-left text-xs transition disabled:opacity-50 ${
                      active
                        ? "border-sky-500 bg-sky-950/60 text-sky-200"
                        : "border-neutral-800 bg-neutral-900 hover:border-neutral-600"
                    }`}
                  >
                    {busy ? "解析中…" : episode.name}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
