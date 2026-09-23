"use client";

import { useCallback, useEffect, useState } from "react";
import { sortByPlayTime } from "@/lib/danmaku/engine";
import { ensureReadableColor, toCssColor } from "@/lib/danmaku/readable-color";
import { danmakuRoomUrl } from "@/lib/danmaku/ws-url";
import {
  applyLocalFilters,
  isValidPattern,
  useDanmakuFilters,
} from "@/lib/danmaku/local-filter";
import type { DanmakuDto } from "@/lib/danmaku/types";


interface Props {
  episodeId: number;
  episodeLabel: string;
  canInteract: boolean;
  schoolId?: string;
  /** 是否已有可播放的视频（决定提示文案）。 */
  hasPlayer: boolean;
}

/**
 * 弹幕列表（**只读浏览**）。
 *
 * 为什么不做独立播放器：曾经这里有个「播放预览」——用 rAF 累加一个假的播放头，
 * canvas 上画弹幕。那是在还没有真播放器时的脚手架。现在播放器已经有了，
 * 再保留它就变成**页面上第二个弹幕画布**，而且是个假时钟，只会让人困惑。
 *
 * 现在的分工：
 * - **播放器**（VideoPlayer）负责 canvas 叠加、发送（需要播放位置）、本校筛选
 * - **本组件**只做「这集大家说了什么」的浏览，按时间排序，标注学校
 *
 * 发送为什么不在列表里做：弹幕必须绑定一个播放时间点，
 * 不播放就没有时间点可绑 —— 硬造一个（比如都发到 0 秒）只会污染数据。
 */
export default function DanmakuList({
  episodeId,
  episodeLabel,
  canInteract,
  schoolId,
  hasPlayer,
}: Props) {
  const [danmakus, setDanmakus] = useState<DanmakuDto[]>([]);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftPattern, setDraftPattern] = useState("");
  /** 外部源状态 —— 让用户知道弹幕从哪来、为什么某源没数据 */
  const [external, setExternal] = useState<{
    localCount: number;
    externalCount: number;
    /** 该集外部弹幕的真实总数；大于 externalCount 说明被截断 */
    externalTotalAvailable: number;
    sources: { service: string; ok: boolean; count: number; error: string | null }[];
  } | null>(null);
  /** 每条弹幕的举报状态，避免重复提交。 */
  const [reported, setReported] = useState<Set<string>>(new Set());

  const filters = useDanmakuFilters();

  const load = useCallback(
    async (onlySchool: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/danmaku", window.location.origin);
        url.searchParams.set("episodeId", String(episodeId));
        url.searchParams.set("limit", "2000");
        if (onlySchool) url.searchParams.set("schoolOnly", "true");

        const response = await fetch(url, { cache: "no-store" });
        const body = (await response.json()) as {
          data?: DanmakuDto[];
          schoolTotal?: number;
          total?: number;
          error?: string;
          external?: {
            localCount: number;
            externalCount: number;
            externalTotalAvailable: number;
            sources: { service: string; ok: boolean; count: number; error: string | null }[];
          };
        };
        if (!response.ok) throw new Error(body.error ?? `拉取失败（${response.status}）`);
        setDanmakus(sortByPlayTime(body.data ?? []));
        setExternal(body.external ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [episodeId],
  );

  useEffect(() => {
    void load(schoolOnly);
  }, [load, schoolOnly]);

  /** 订阅实时新增 —— 别人在播的时候发的弹幕，这里也能看到。 */
  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(danmakuRoomUrl(episodeId, schoolOnly));
    } catch {
      return; // WS 不可用不影响列表（已由 REST 拉取）
    }

    socket.addEventListener("message", (event) => {
      if (cancelled) return;
      const payload = JSON.parse(String(event.data)) as {
        type: string;
        danmaku?: DanmakuDto;
      };
      if (payload.type === "add" && payload.danmaku) {
        setDanmakus((prev) =>
          prev.some((d) => d.id === payload.danmaku!.id)
            ? prev
            : sortByPlayTime([...prev, payload.danmaku!]),
        );
      }
    });

    return () => {
      cancelled = true;
      socket.close();
    };
  }, [episodeId, schoolOnly]);

  const visible = applyLocalFilters(danmakus, filters.state);
  const hiddenCount = danmakus.length - visible.length;

  const report = async (danmakuId: string) => {
    try {
      const response = await fetch("/api/danmaku/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ danmakuId, reason: "用户举报" }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "举报失败");
      setReported((prev) => new Set(prev).add(danmakuId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const fmtTime = (ms: number) => {
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">弹幕 · {episodeLabel}</h2>
        <span className="text-xs text-ink-faint">
          {visible.length} 条
          {hiddenCount > 0 && (
            <span className="ml-1 text-ink-faint">（本地过滤隐藏 {hiddenCount} 条）</span>
          )}
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schoolOnly}
            disabled={!canInteract}
            onChange={(event) => setSchoolOnly(event.target.checked)}
            className="size-4 accent-sky-500"
          />
          <span className={canInteract ? "" : "text-ink-faint"}>只看本校</span>
        </label>
      </div>

      <p className="text-xs text-ink-faint">
        {hasPlayer
          ? "弹幕会叠加在上方播放器上；发送请用播放器的输入框（需要播放位置）。"
          : "这里只是浏览。要发弹幕需要先有可播放的视频 —— 到「设置」连接你的 Jellyfin/Emby 媒体库。"}
      </p>

      {/*
        外部源状态。没有这一块的话，用户看到弹幕数量对不上会以为是 bug ——
        实际是「校内 0 条 + Animeko 17 条」这种组合。
      */}
      {external && (external.externalCount > 0 || external.sources.length > 0) && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <span>
            本校 {external.localCount} 条
            {external.externalCount > 0 && ` · 外部源 ${external.externalCount} 条`}
          </span>

          {/*
            截断提示刻意比同行的其他统计**更亮**（ink-muted vs ink-faint）。

            理由：这条信息的作用是消除误解 ——「不说明的话用户会以为这集
            只有这么点弹幕」。既然它的职责是「必须被读到」，就不能跟旁边的
            装饰性计数同色，否则等于没写。原先内外都是 ink-faint，
            层级重复且埋没了重点。
          */}
          {external.externalTotalAvailable > external.externalCount && (
            <span className="text-ink-muted">
              共 {external.externalTotalAvailable} 条，已显示前 {external.externalCount} 条
            </span>
          )}
          {external.sources.map((source) => (
            <span
              key={source.service}
              className={`rounded px-1.5 py-0.5 ${
                source.ok
                  ? "bg-surface-3 text-ink-muted"
                  : "bg-warn/10 text-warn"
              }`}
              title={source.error ?? undefined}
            >
              {source.service}
              {source.ok ? ` ${source.count}` : " 失败"}
            </span>
          ))}
          {external.externalCount > 0 && (
            <span className="text-ink-faint">
              （外部弹幕不属于任何学校，开启「只看本校」会隐藏它们）
            </span>
          )}
        </p>
      )}

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}

      {/* 本地屏蔽词：用户自己的偏好，与服务端全局屏蔽词互补 */}
      <details className="panel bg-surface-2 p-3 text-xs">
        <summary className="cursor-pointer text-ink-muted">
          本地屏蔽词 {filters.state.patterns.length > 0 && `(${filters.state.patterns.length})`}
          {hiddenCount > 0 && <span className="ml-2 text-ink-faint">正在隐藏 {hiddenCount} 条</span>}
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-ink-faint">
            支持正则，只影响你自己（存在本机，不上传）。
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              value={draftPattern}
              onChange={(event) => setDraftPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  filters.addPattern(draftPattern);
                  setDraftPattern("");
                }
              }}
              placeholder="例如：剧透|前|哈哈"
              className="input min-w-40 flex-1 py-1"
            />
            <button
              type="button"
              onClick={() => {
                filters.addPattern(draftPattern);
                setDraftPattern("");
              }}
              disabled={draftPattern.trim().length === 0 || !isValidPattern(draftPattern)}
              className="btn btn-ghost btn-sm"
            >
              添加
            </button>
          </div>
          {draftPattern.trim().length > 0 && !isValidPattern(draftPattern) && (
            <p className="text-warn">正则不合法，暂不生效（继续输入即可）</p>
          )}
          {filters.state.patterns.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {filters.state.patterns.map((pattern) => (
                <li key={pattern}>
                  <button
                    type="button"
                    onClick={() => filters.removePattern(pattern)}
                    className="rounded bg-surface-3 px-2 py-0.5 font-mono hover:bg-surface-3"
                    title="点击移除"
                  >
                    {pattern} ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-center gap-2 text-ink-faint">
            <input
              type="checkbox"
              checked={filters.state.enabled}
              onChange={(event) => filters.setEnabled(event.target.checked)}
              className="size-3.5 accent-sky-500"
            />
            启用本地过滤
          </label>
        </div>
      </details>

      {loading && <p className="text-sm text-ink-faint">加载中…</p>}

      {!loading && visible.length === 0 && danmakus.length > 0 && (
        <p className="panel text-sm text-ink-faint">
          全部 {danmakus.length} 条弹幕都被你的本地屏蔽词过滤了。
        </p>
      )}

      {!loading && danmakus.length === 0 && (
        <p className="panel text-sm text-ink-faint">
          {schoolOnly ? "本校还没有人在这集发弹幕。" : "这集还没有弹幕。"}
        </p>
      )}

      <ul className="max-h-80 space-y-0.5 overflow-y-auto rounded border border-line p-3 text-sm">
        {visible.map((danmaku) => (
          <li key={danmaku.id} className="group flex gap-3">
            <span className="w-12 shrink-0 font-mono text-xs text-ink-faint">
              {fmtTime(danmaku.playTimeMs)}
            </span>
            <span
              className={`shrink-0 rounded px-1.5 text-xs ${
                schoolId && danmaku.schoolId === schoolId
                  ? "bg-accent-dim/70 text-accent"
                  : "bg-surface-3 text-ink-faint"
              }`}
            >
              {danmaku.schoolId === schoolId ? "本校" : danmaku.schoolId || "外部"}
            </span>
            <span className="shrink-0 text-xs text-ink-faint">{danmaku.senderName}</span>
            <span
              className="break-all"
              /*
               * 颜色由发送者指定，而我们是深色界面 —— 实测 17% 的弹幕
               * 在深色背景上不可读（深蓝 1.63:1、深灰 1.32:1）。
               * `ensureReadableColor` 保留色相、只提亮度。
               */
              style={{ color: toCssColor(ensureReadableColor(danmaku.color)) }}
            >
              {danmaku.text}
            </span>

            {/* 举报：UGC 的必要配套。悬停才显示，避免视觉噪音。 */}
            {canInteract && (
              <button
                type="button"
                onClick={() => void report(danmaku.id)}
                disabled={reported.has(danmaku.id)}
                /*
                 * 两处对比度上的取舍：
                 *
                 * 1. 不用 opacity-0 + group-hover 隐藏 —— 触屏没有 hover，
                 *    手机上按钮会永远看不见，必须常显。
                 * 2. 用 ink-muted 而非 ink-faint：举报是**操作**，不是元信息。
                 *    与时间戳同色会让它被视觉归类为「可忽略的辅助文字」。
                 */
                className="ml-auto shrink-0 rounded px-1.5 text-xs text-ink-muted transition hover:bg-danger/10 hover:text-danger disabled:text-ink-faint"
                title="举报这条弹幕"
              >
                {reported.has(danmaku.id) ? "已举报" : "举报"}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
