"use client";

import { useCallback, useEffect, useState } from "react";
import DanmakuPanel from "@/components/danmaku-panel";
import ReviewPanel from "@/components/review-panel";

export interface EpisodeItem {
  id: number;
  sort: number;
  ep: number | null;
  name: string;
  nameCn: string | null;
  airdate: string | null;
  duration: string | null;
  danmakuCount: number;
  schoolDanmakuCount: number;
}

/** 单集观看状态，数值对齐 BGM `EpisodeCollectionType`。 */
const PROGRESS_LABELS: Record<number, string> = {
  0: "未看",
  1: "想看",
  2: "看过",
  3: "抛弃",
};

interface Props {
  subjectId: number;
  episodes: EpisodeItem[];
  canInteract: boolean;
  schoolId?: string;
  bgmBound: boolean;
}

/** 章节选择 + 进度标记 + 弹幕 / 评论面板的组合容器。 */
export default function EpisodeWorkspace({
  subjectId,
  episodes,
  canInteract,
  schoolId,
  bgmBound,
}: Props) {
  const [selectedId, setSelectedId] = useState<number | null>(episodes[0]?.id ?? null);
  const [progress, setProgress] = useState<Record<number, number>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  const selected = episodes.find((episode) => episode.id === selectedId) ?? episodes[0];

  useEffect(() => {
    if (!canInteract) return;
    let cancelled = false;
    fetch(`/api/progress?subjectId=${subjectId}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ entries?: Record<string, number> }>)
      .then((body) => {
        if (cancelled || !body.entries) return;
        const parsed: Record<number, number> = {};
        for (const [key, value] of Object.entries(body.entries)) parsed[Number(key)] = value;
        setProgress(parsed);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [subjectId, canInteract]);

  const markEpisode = useCallback(async (episodeId: number, type: number) => {
    setPending(episodeId);
    setSaveError(null);
    // 乐观更新：先动 UI，失败再回滚
    const previous = progress[episodeId] ?? 0;
    setProgress((current) => ({ ...current, [episodeId]: type }));

    try {
      const response = await fetch("/api/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, type }),
      });
      const body = (await response.json()) as {
        error?: string;
        bgmBound?: boolean;
        bgmSynced?: boolean | null;
        bgmError?: string | null;
      };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
      if (body.bgmBound && !body.bgmSynced && body.bgmError) {
        setSaveError(`已保存在本站，但同步到 Bangumi 失败：${body.bgmError}`);
      }
    } catch (error) {
      setProgress((current) => ({ ...current, [episodeId]: previous }));
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  }, [progress]);

  if (!selected) {
    return (
      <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">
        该条目暂无章节数据。
      </p>
    );
  }

  const label = selected.nameCn || selected.name || `第 ${selected.sort} 集`;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-lg font-semibold">章节</h2>
          <span className="text-xs text-neutral-500">
            {canInteract
              ? bgmBound
                ? "标记后同步写入 Bangumi"
                : "标记后仅保存在本站（绑定 Bangumi 后可同步）"
              : "登录后可标记观看进度"}
          </span>
        </div>

        {saveError && (
          <p className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
            {saveError}
          </p>
        )}

        <ul className="flex flex-wrap gap-2">
          {episodes.map((episode) => {
            const active = episode.id === selected.id;
            const state = progress[episode.id] ?? 0;
            return (
              <li key={episode.id}>
                <div
                  className={`flex items-center gap-2 rounded border px-3 py-1.5 text-sm transition ${
                    active
                      ? "border-sky-500 bg-sky-950/60 text-sky-200"
                      : "border-neutral-800 bg-neutral-900 hover:border-neutral-600"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(episode.id)}
                    title={episode.nameCn || episode.name}
                    className="text-left"
                  >
                    <span className="font-mono text-xs opacity-70">
                      EP{episode.ep ?? episode.sort}
                    </span>
                    <span className="ml-2">{episode.nameCn || episode.name}</span>
                    <span className="ml-2 text-xs text-neutral-500">
                      弹幕 {episode.danmakuCount}
                      {schoolId ? ` / 本校 ${episode.schoolDanmakuCount}` : ""}
                    </span>
                  </button>

                  <select
                    value={state}
                    disabled={!canInteract || pending === episode.id}
                    onChange={(event) => void markEpisode(episode.id, Number(event.target.value))}
                    title="观看状态"
                    className="rounded border border-neutral-700 bg-neutral-900 px-1 py-0.5 text-xs disabled:opacity-40"
                  >
                    {Object.entries(PROGRESS_LABELS).map(([value, text]) => (
                      <option key={value} value={value}>
                        {text}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <DanmakuPanel
        key={selected.id}
        episodeId={selected.id}
        episodeLabel={label}
        canInteract={canInteract}
        schoolId={schoolId}
      />

      <ReviewPanel subjectId={subjectId} canInteract={canInteract} schoolId={schoolId} />
    </div>
  );
}
