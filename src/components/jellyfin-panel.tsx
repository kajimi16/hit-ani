"use client";

import { useCallback, useEffect, useState } from "react";
import VideoPlayer from "@/components/video-player";

interface JellyfinMatch {
  connectionId: string;
  connectionName: string;
  series: { id: string; name: string; year: number | null; posterUrl: string } | null;
  matchMethod: string;
  distance: number | null;
  error: string | null;
}

interface PlayableEpisode {
  id: string;
  name: string;
  season: number | null;
  episode: number | null;
  durationMs: number | null;
  played: boolean;
  positionMs: number;
  streamUrl: string;
  resumeFromMs: number;
}

interface Props {
  subjectId: number;
  /**
   * BGM 的剧集列表，用于把 Jellyfin 的集**按序号**对齐回 BGM 的 episodeId。
   *
   * 为什么必须对齐：弹幕是按 BGM 的 `episodeId` 存储的，而 Jellyfin 的集 id
   * 与它毫无关系。若不映射就传 subjectId 当作 episodeId，弹幕会挂到错误的集上 ——
   * 那是静默的数据错位，比「没有弹幕」更糟。
   */
  bgmEpisodes: { id: number; sort: number; ep: number | null }[];
  canInteract: boolean;
  hasConnections: boolean;
}

const MATCH_LABEL: Record<string, string> = {
  EXACT_NAME: "精确匹配",
  FUZZY: "模糊匹配",
  NO_MATCH: "未匹配",
  EXACT_NUMBER: "精确匹配",
  EXACT_SUBJECT_FUZZY_EPISODE: "番剧精确、集名模糊",
};

/**
 * 条目页的「在这里看」面板。
 *
 * 流程：把 BGM 条目匹配到用户 Jellyfin 库里的系列 → 列出剧集 → 播放。
 * 视频字节由浏览器直连 Jellyfin，不经过本平台。
 */
export default function JellyfinPanel({
  subjectId,
  bgmEpisodes,
  canInteract,
  hasConnections,
}: Props) {
  /**
   * 播放进度上报：看到 90% 以上时把该集标记为「看过」，并镜像回 Bangumi。
   *
   * 两个刻意的决定：
   *
   * 1. **不记录具体播放位置**。位置由 Jellyfin 维护（`UserData.PlaybackPositionTicks`，
   *    已在 `listPlayableEpisodes` 里读取并用于续播），本地再存一份只会两边打架，
   *    而且 Jellyfin 的位置是跨设备的（手机 App 看的进度也会同步）。
   * 2. **只在达到阈值时上报**。每次 timeupdate 都写库会打爆数据库，
   *    而「看了 1 分钟」标成已看也不符合用户预期 —— 阈值对齐 Animeko 的
   *    `MarkAsWatchedExtension`（`pos >= min(duration*0.9, duration - 100s)`）。
   */
  const reportProgress = useCallback(
    async (bgmEpisodeId: number, positionMs: number, durationMs: number) => {
      if (durationMs <= 0) return;
      const nearlyDone = positionMs >= Math.min(durationMs * 0.9, durationMs - 100_000);
      if (!nearlyDone) return;

      try {
        await fetch("/api/progress", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          // EpisodeCollectionType: 2 = 看过
          body: JSON.stringify({ episodeId: bgmEpisodeId, type: 2 }),
        });
      } catch {
        /* 进度上报失败不影响播放 */
      }
    },
    [],
  );
  const [matches, setMatches] = useState<JellyfinMatch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<JellyfinMatch | null>(null);
  const [episodes, setEpisodes] = useState<PlayableEpisode[] | null>(null);
  const [playing, setPlaying] = useState<PlayableEpisode | null>(null);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/media/jellyfin/library?subjectId=${subjectId}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as { matches?: JellyfinMatch[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "匹配失败");
      setMatches(body.matches ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [subjectId]);

  useEffect(() => {
    if (hasConnections) void loadMatches();
  }, [hasConnections, loadMatches]);

  const openSeries = async (match: JellyfinMatch) => {
    if (!match.series) return;
    setSelected(match);
    setEpisodes(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/media/jellyfin/library?connectionId=${match.connectionId}&seriesId=${match.series.id}`,
        { cache: "no-store" },
      );
      const body = (await response.json()) as { episodes?: PlayableEpisode[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "获取剧集失败");
      setEpisodes(body.episodes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * 当前播放的 Jellyfin 集对应的 BGM episodeId。
   *
   * 按**序号**对齐：先用 Jellyfin 的集号匹配 BGM 的 `ep`，再退回 `sort`。
   * 找不到时为 null —— VideoPlayer 会禁用弹幕，而不是用一个错误的 id
   * （那会把弹幕和进度都挂到别的集上）。
   */
  const bgmEpisodeId =
    playing === null
      ? null
      : (bgmEpisodes.find((e) => e.ep === playing.episode)?.id ??
        bgmEpisodes.find((e) => e.sort === playing.episode)?.id ??
        null);

  if (!hasConnections) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">在这里看</h2>
        <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">
          还没有连接媒体服务器。到{" "}
          <a href="/sources" className="text-sky-400 underline">
            媒体源
          </a>{" "}
          页面连接你自己的 Jellyfin / Emby，
          就能在这里播放你媒体库里的资源（视频直连你的服务器，不经过本平台）。
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">在这里看</h2>
        <span className="text-xs text-neutral-500">
          视频由你的媒体服务器直连播放，本平台不传输视频
        </span>
        <button
          type="button"
          onClick={() => void loadMatches()}
          disabled={loading}
          className="ml-auto rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
        >
          {loading ? "匹配中…" : "重新匹配"}
        </button>
      </div>

      {playing && (
        <VideoPlayer
          key={playing.id}
          episodeId={bgmEpisodeId}
          title={playing.name}
          streamUrl={playing.streamUrl}
          startAtMs={playing.resumeFromMs}
          canInteract={canInteract}
          onProgress={
            bgmEpisodeId === null
              ? undefined
              : (positionMs, durationMs) => void reportProgress(bgmEpisodeId, positionMs, durationMs)
          }
        />
      )}

      {matches && matches.length === 0 && (
        <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">
          没有已连接的媒体服务器。
        </p>
      )}

      {matches && matches.length > 0 && !selected && (
        <ul className="space-y-2">
          {matches.map((match) => (
            <li
              key={match.connectionId}
              className="flex flex-wrap items-center gap-3 rounded border border-neutral-800 p-3 text-sm"
            >
              <span className="text-neutral-400">{match.connectionName}</span>
              {match.error ? (
                <span className="text-xs text-red-300">{match.error}</span>
              ) : match.series ? (
                <>
                  <span className="font-medium">{match.series.name}</span>
                  {match.series.year && (
                    <span className="text-xs text-neutral-500">{match.series.year}</span>
                  )}
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      match.matchMethod === "FUZZY"
                        ? "bg-amber-900/60 text-amber-300"
                        : "bg-emerald-900/60 text-emerald-300"
                    }`}
                  >
                    {MATCH_LABEL[match.matchMethod] ?? match.matchMethod}
                    {match.distance !== null && ` (距离 ${match.distance})`}
                  </span>
                  <button
                    type="button"
                    onClick={() => void openSeries(match)}
                    className="ml-auto rounded bg-sky-600 px-3 py-1 text-xs text-white hover:bg-sky-500"
                  >
                    查看剧集
                  </button>
                </>
              ) : (
                <span className="text-xs text-neutral-500">库里没有这部番</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-sm">
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setEpisodes(null);
                setPlaying(null);
              }}
              className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
            >
              ← 返回
            </button>
            <span className="font-medium">{selected.series?.name}</span>
            <span className="text-xs text-neutral-500">{selected.connectionName}</span>
          </div>

          {episodes === null ? (
            <p className="text-sm text-neutral-500">读取剧集中…</p>
          ) : episodes.length === 0 ? (
            <p className="text-sm text-neutral-500">这个系列下没有剧集文件。</p>
          ) : (
            <ul className="grid gap-1 sm:grid-cols-2">
              {episodes.map((episode) => {
                const active = playing?.id === episode.id;
                return (
                  <li key={episode.id}>
                    <button
                      type="button"
                      onClick={() => setPlaying(episode)}
                      className={`w-full rounded border px-3 py-2 text-left text-sm transition ${
                        active
                          ? "border-sky-500 bg-sky-950/60 text-sky-200"
                          : "border-neutral-800 bg-neutral-900 hover:border-neutral-600"
                      }`}
                    >
                      <span className="font-mono text-xs opacity-70">
                        {episode.season !== null && `S${episode.season} `}
                        {episode.episode !== null ? `EP${episode.episode}` : ""}
                      </span>
                      <span className="ml-2">{episode.name}</span>
                      {episode.played && (
                        <span className="ml-2 rounded bg-neutral-800 px-1.5 text-xs text-neutral-400">
                          已看
                        </span>
                      )}
                      {!episode.played && episode.positionMs > 0 && (
                        <span className="ml-2 text-xs text-amber-400">
                          续播 {Math.floor(episode.positionMs / 60000)} 分
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </section>
  );
}
