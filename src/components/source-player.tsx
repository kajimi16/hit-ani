"use client";

import { useCallback, useEffect, useState } from "react";
import VideoPlayer from "@/components/video-player";
import { resumeStartMs } from "@/lib/player/controls";

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
  /**
   * 上次看到的位置（毫秒）；从未播放过时 null。
   *
   * **只有外站源这条路径需要它**：Jellyfin 那条由 Jellyfin 自己维护播放位置
   * （`UserData.PlaybackPositionTicks`，且跨设备同步），本地再存一份只会
   * 两边打架 —— 那个决定是有意为之，见 `jellyfin-panel.tsx` 的注释。
   */
  resumePositionMs?: number | null;
  /**
   * `resumePositionMs` 属于哪一集（BGM episodeId）。
   *
   * 位置在库里是**条目级**的（一部番同时只在一个位置续看），所以必须靠
   * 集号判断「现在播的这一集是不是上次看到的那一集」——
   * 否则看完第 1 集自动切到第 2 集时，第 2 集会在开头就跳到第 1 集的
   * 片尾位置，于是立刻又触发「播完」，一集接一集地空转。
   */
  resumeEpisodeId?: number | null;
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
  resumePositionMs = null,
  resumeEpisodeId = null,
  onClose,
}: Props) {
  /**
   * 上报播放位置。
   *
   * **只报位置，不带 `type`** —— 位置与观看状态是两件正交的事，让「上报看到
   * 第几秒」顺带把该集标成「想看」是明显的错误（接口那边 `type` 已改为可选）。
   *
   * 服务端会**独立钳制**这个值：客户端可被篡改，且程序化赋值
   * `video.currentTime` 能绕过客户端的一切限制。
   */
  const reportPosition = useCallback(
    async (bgmEpisodeId: number, positionMs: number) => {
      try {
        await fetch("/api/progress", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ episodeId: bgmEpisodeId, playbackPositionMs: positionMs }),
        });
      } catch {
        /* 位置上报失败不影响播放 —— 它只是「下次接着看」的便利 */
      }
    },
    [],
  );

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
   * 当前播放集在列表里的下一集。
   *
   * 按**列表顺序**取而不是「集号 +1」：源站命名很杂（`第 5.5 话`、
   * 总集篇、特典），按集号推算会跳到一个不存在或错位的集上。
   * 找不到当前集时返回 null —— 宁可停住，也不要跳到未知的位置。
   */
  let nextEpisode: Episode | null = null;
  if (playing !== null && episodes !== null) {
    const index = episodes.findIndex((e) => e.name === playing.name);
    if (index >= 0 && index + 1 < episodes.length) nextEpisode = episodes[index + 1];
  }

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
    <div className="panel accent-bar space-y-4 border-primary/40 bg-primary-container/20">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-primary">站内播放 · {sourceName}</span>
        <span className="text-xs text-on-surface-variant/70">
          视频由来源站 CDN 直连你的浏览器，不经过本平台
        </span>


        <button
          type="button"
          onClick={onClose}
          className="btn btn-ghost btn-sm ml-auto"
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
          // 续播：外站源没有服务端播放记录，只能靠我们自己存的这条位置
          /*
           * 续播判定走纯函数（`resumeStartMs`，有测试）：只有「当前这集 ==
           * 记着的那集」才用记下的位置，否则从 0 开始。**不能**写成
           * `resumePositionMs ?? 0` —— 那是一次会话内不变的服务端渲染属性，
           * 而换集只是重新挂载播放器，于是每一集都会用同一个位置续播。
           */
          startAtMs={resumeStartMs({
            currentEpisodeId: bgmEpisodeId,
            recordedEpisodeId: resumeEpisodeId,
            recordedPositionMs: resumePositionMs,
          })}
          canInteract={canInteract}
          onProgress={
            /*
             * 位置上报。**每次都报**（播放器内部已按 `PROGRESS_REPORT_INTERVAL_MS`
             * 节流），服务端会独立钳制 —— 客户端上报的值不可信。
             *
             * 与 Jellyfin 那条路径的差别：那边只在接近看完时上报「标记看过」，
             * 因为位置由 Jellyfin 管；这里位置只有我们能存。
             *
             * 没对齐到 BGM 集号时不报（服务端要 episodeId 才能定位到条目，
             * 而外部源的集号可能与 BGM 对不上）。
             */
            bgmEpisodeId === null
              ? undefined
              : (positionMs) => void reportPosition(bgmEpisodeId, positionMs)
          }
          /*
           * 自动连播：播完切下一集。解析（`play`）与当前是同一台机器上
           * 同一次播放，不涉及服务端状态。
           */
          hasNext={nextEpisode !== null}
          onEnded={() => {
            if (nextEpisode) void play(nextEpisode);
          }}
        />
      )}

      <div className="space-y-2">
        <p className="text-xs text-on-surface-variant">
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
                        ? "border-primary bg-primary-container text-primary"
                        : "border-outline-variant bg-surface-container-low hover:border-outline"
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
        <p className="alert alert-danger">
          {error}
        </p>
      )}
    </div>
  );
}
