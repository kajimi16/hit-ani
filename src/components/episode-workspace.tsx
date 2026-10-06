"use client";

import { useCallback, useEffect, useState } from "react";
import DanmakuList from "@/components/danmaku-list";
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
}

/** 章节选择 + 进度标记 + 弹幕 / 评论面板的组合容器。 */
export default function EpisodeWorkspace({
  subjectId,
  episodes,
  canInteract,
  schoolId,
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
        bgmSkip?: "user-disabled" | "ops-disabled" | "test-account" | null;
      };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
      /*
       * 只在**真的失败**时报错。用户没开同步（默认）或管理员临时关闭时，
       * 进度已经正确保存在本站 —— 那不是错误，不该弹红字。
       */
      if (body.bgmBound && !body.bgmSynced && body.bgmSkip !== "user-disabled" && body.bgmSkip !== "ops-disabled") {
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
      <p className="panel text-sm text-on-surface-variant/70">
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
          {/*
            只保留「登录后可标记」这一句：未登录时进度控件是禁用的，
            没有这句用户不知道原因。另外两句（「同步写入 Bangumi」/「仅保存在本站」）
            按用户要求去掉。
          */}
          {!canInteract && (
            <span className="text-xs text-on-surface-variant/70">登录后可标记观看进度</span>
          )}
        </div>

        {saveError && (
          <p className="alert alert-warn">
            {saveError}
          </p>
        )}

        {/*
          章节格（`EpisodeGridCell`）：网格而非长条列表 —— Animeko 的选集
          界面就是格子，扫视时比逐行读标题快得多。
          「看过」状态直接做进格子底色/文字，不必再逐条展开下拉。
        */}
        <ul className="episode-grid">
          {episodes.map((episode) => {
            const active = episode.id === selected.id;
            const state = progress[episode.id] ?? 0;
            return (
              <li key={episode.id}>
                <div
                  aria-current={active ? "true" : undefined}
                  data-watched={state === 2 ? "true" : undefined}
                  className="episode-cell h-full"
                >
                  {/*
                    主按钮铺满整格 —— 点格子＝选中该集。
                    （曾经把进度下拉做成铺满的透明层，结果点格子只会打开状态
                    菜单、再也选不中集数。两个动作必须各自有自己的命中区。）
                  */}
                  <button
                    type="button"
                    onClick={() => setSelectedId(episode.id)}
                    title={episode.nameCn || episode.name}
                    className="flex h-full w-full flex-col text-left"
                  >
                    <span className="episode-cell__number">
                      EP{episode.ep ?? episode.sort}
                    </span>
                    <span className="episode-cell__title">
                      {episode.nameCn || episode.name}
                    </span>
                    <span className="episode-cell__meta">
                      弹幕 {episode.danmakuCount}
                      {schoolId ? ` · 本校 ${episode.schoolDanmakuCount}` : ""}
                    </span>
                  </button>

                  {/*
                    进度标记：只占右下角一小块，且**可见** ——
                    不可见的控件等于没有这个功能。
                  */}
                  <select
                    value={state}
                    disabled={!canInteract || pending === episode.id}
                    onChange={(event) => void markEpisode(episode.id, Number(event.target.value))}
                    aria-label={`第 ${episode.ep ?? episode.sort} 集观看状态`}
                    title="观看状态"
                    className="mt-2 w-full rounded border border-outline-variant bg-surface-container-lowest px-1 py-0.5 text-[0.6875rem] text-on-surface-variant"
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

      <DanmakuList
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
