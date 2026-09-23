"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { allocateTracks, sortByPlayTime } from "@/lib/danmaku/engine";
import {
  DanmakuLocation,
  type DanmakuDto,
  type DanmakuLocationValue,
} from "@/lib/danmaku/types";

const WS_BASE = process.env.NEXT_PUBLIC_DANMAKU_WS_URL ?? "ws://localhost:3102";
const TRACK_COUNT = 8;
const CANVAS_HEIGHT = TRACK_COUNT * 26;
const TRACK_HEIGHT = 26;
const SPEED_PX_PER_MS = 0.18;
const CHAR_WIDTH = 16;

interface Props {
  episodeId: number;
  episodeLabel: string;
  /** 是否已登录 —— 未登录时禁用发送与本校筛选。 */
  canInteract: boolean;
  /** 当前用户学校，用于服务端校验展示。 */
  schoolId?: string;
}

type ConnectionState = "connecting" | "open" | "closed" | "fallback";

/**
 * 弹幕面板。
 *
 * 传输策略：优先 WebSocket 网关（实时广播）；网关不可用时退回 REST 轮询式拉取，
 * 保证「看番」这条链路在只跑 Next.js 时也不会彻底失效。
 */
export default function DanmakuPanel({
  episodeId,
  episodeLabel,
  canInteract,
  schoolId,
}: Props) {
  const [danmakus, setDanmakus] = useState<DanmakuDto[]>([]);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [position, setPosition] = useState<DanmakuLocationValue>(DanmakuLocation.Normal);
  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** REST 拉取（也是 WS 不可用时的兜底路径）。 */
  const fetchRest = useCallback(
    async (onlySchool: boolean) => {
      const url = new URL("/api/danmaku", window.location.origin);
      url.searchParams.set("episodeId", String(episodeId));
      url.searchParams.set("limit", "2000");
      if (onlySchool) url.searchParams.set("schoolOnly", "true");

      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `拉取失败（${response.status}）`);
      }
      const body = (await response.json()) as { data: DanmakuDto[] };
      setDanmakus(sortByPlayTime(body.data));
    },
    [episodeId],
  );

  /** 建立 WS 连接；失败时降级为 REST。 */
  useEffect(() => {
    let cancelled = false;
    setDanmakus([]);
    setError(null);
    setConnection("connecting");

    const url = new URL(`${WS_BASE}/danmaku/room/${episodeId}`);
    if (schoolOnly) url.searchParams.set("schoolOnly", "true");

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setConnection("fallback");
      void fetchRest(schoolOnly).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    socketRef.current = socket;

    socket.addEventListener("open", () => {
      if (!cancelled) setConnection("open");
    });

    socket.addEventListener("message", (event) => {
      if (cancelled) return;
      const payload = JSON.parse(String(event.data)) as {
        type: string;
        list?: DanmakuDto[];
        danmaku?: DanmakuDto;
        message?: string;
      };

      if (payload.type === "repopulate" && payload.list) {
        setDanmakus(sortByPlayTime(payload.list));
      } else if (payload.type === "add" && payload.danmaku) {
        setDanmakus((prev) =>
          prev.some((d) => d.id === payload.danmaku!.id)
            ? prev
            : sortByPlayTime([...prev, payload.danmaku!]),
        );
      } else if (payload.type === "error" && payload.message) {
        setError(payload.message);
      }
    });

    socket.addEventListener("error", () => {
      if (cancelled) return;
      setConnection("fallback");
      void fetchRest(schoolOnly).catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    });

    socket.addEventListener("close", () => {
      if (!cancelled && socketRef.current === socket) {
        setConnection((prev) => (prev === "open" ? "closed" : prev));
      }
    });

    return () => {
      cancelled = true;
      socketRef.current = null;
      socket.close();
    };
  }, [episodeId, schoolOnly, fetchRest]);

  /** 播放头推进（MVP 无片源，用虚拟时钟驱动弹幕渲染）。 */
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      setPlayheadMs((prev) => prev + delta);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const visible = useMemo(
    () => danmakus.filter((d) => d.playTimeMs <= playheadMs + 8000),
    [danmakus, playheadMs],
  );

  /** canvas 渲染：轨道由 allocateTracks 决定，与服务端/客户端同一套算法。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    canvas.width = width * dpr;
    canvas.height = CANVAS_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, CANVAS_HEIGHT);

    const assignments = allocateTracks(visible, {
      trackCount: TRACK_COUNT,
      viewportWidth: width,
      charWidth: CHAR_WIDTH,
      speedPxPerMs: SPEED_PX_PER_MS,
    });

    for (const { danmaku, track } of assignments) {
      const elapsed = playheadMs - danmaku.playTimeMs;
      if (elapsed < 0) continue;

      const textWidth = Array.from(danmaku.text).length * CHAR_WIDTH;
      const topY = track * TRACK_HEIGHT + 18;

      ctx.font = "16px system-ui, sans-serif";
      ctx.fillStyle = `#${danmaku.color.toString(16).padStart(6, "0")}`;
      ctx.shadowColor = "rgba(0,0,0,0.85)";
      ctx.shadowBlur = 3;

      if (danmaku.location === DanmakuLocation.Normal) {
        const x = width - elapsed * SPEED_PX_PER_MS;
        if (x + textWidth < 0) continue;
        ctx.fillText(danmaku.text, x, topY);
      } else {
        const x = (width - textWidth) / 2;
        const y =
          danmaku.location === DanmakuLocation.Top
            ? 16 + track * TRACK_HEIGHT
            : CANVAS_HEIGHT - 10 - track * TRACK_HEIGHT;
        ctx.fillText(danmaku.text, x, y);
      }
      ctx.shadowBlur = 0;
    }
  }, [visible, playheadMs]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !canInteract) return;

    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "send",
          playTimeMs: Math.round(playheadMs),
          text,
          location: position,
        }),
      );
      setDraft("");
      return;
    }

    try {
      const response = await fetch("/api/danmaku", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ episodeId, playTimeMs: Math.round(playheadMs), text, location: position }),
      });
      const body = (await response.json()) as { data?: DanmakuDto; error?: string };
      if (!response.ok) throw new Error(body.error ?? "发送失败");
      if (body.data) {
        setDanmakus((prev) => sortByPlayTime([...prev, body.data!]));
      }
      setDraft("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const connectionLabel: Record<ConnectionState, string> = {
    connecting: "连接中…",
    open: "实时连接",
    closed: "连接已断开",
    fallback: "REST 模式",
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">弹幕 · {episodeLabel}</h2>
        <span
          className={`rounded px-2 py-0.5 text-xs ${
            connection === "open"
              ? "bg-emerald-900/60 text-emerald-300"
              : connection === "fallback"
                ? "bg-amber-900/60 text-amber-300"
                : "bg-neutral-800 text-neutral-400"
          }`}
        >
          {connectionLabel[connection]}
        </span>
        <span className="text-xs text-neutral-500">
          已加载 {danmakus.length} 条
        </span>

        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schoolOnly}
            disabled={!canInteract}
            onChange={(event) => setSchoolOnly(event.target.checked)}
            className="size-4 accent-sky-500"
          />
          <span className={canInteract ? "" : "text-neutral-600"}>只看本校弹幕</span>
          {schoolId && <span className="rounded bg-neutral-800 px-2 py-0.5 text-xs">{schoolId}</span>}
        </label>
      </div>

      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: CANVAS_HEIGHT }}
        className="rounded border border-neutral-800 bg-gradient-to-b from-neutral-900 to-neutral-950"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((value) => !value)}
          className="rounded bg-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-700"
        >
          {playing ? "暂停预览" : "播放预览"}
        </button>
        <span className="font-mono text-xs text-neutral-500">
          {(playheadMs / 1000).toFixed(1)}s
        </span>
        <input
          type="range"
          min={0}
          max={180000}
          value={Math.round(playheadMs)}
          onChange={(event) => setPlayheadMs(Number(event.target.value))}
          className="min-w-48 flex-1 accent-sky-500"
        />
        <select
          value={position}
          onChange={(event) => setPosition(Number(event.target.value) as DanmakuLocationValue)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
        >
          <option value={DanmakuLocation.Normal}>滚动</option>
          <option value={DanmakuLocation.Top}>顶部</option>
          <option value={DanmakuLocation.Bottom}>底部</option>
        </select>
      </div>

      <div className="flex gap-3">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          disabled={!canInteract}
          placeholder={canInteract ? "发一条弹幕（回车发送）" : "登录后可发送弹幕"}
          className="flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canInteract || draft.trim().length === 0}
          className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
        >
          发送
        </button>
      </div>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <ul className="max-h-64 space-y-1 overflow-y-auto rounded border border-neutral-800 p-3 text-sm">
        {danmakus.length === 0 && (
          <li className="text-neutral-500">本集还没有弹幕，来发第一条。</li>
        )}
        {danmakus.map((danmaku) => (
          <li key={danmaku.id} className="flex gap-3">
            <span className="w-16 shrink-0 font-mono text-xs text-neutral-500">
              {(danmaku.playTimeMs / 1000).toFixed(1)}s
            </span>
            <span
              className={`shrink-0 rounded px-1.5 text-xs ${
                schoolId && danmaku.schoolId === schoolId
                  ? "bg-sky-900/70 text-sky-300"
                  : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {danmaku.schoolId === schoolId ? "本校" : danmaku.schoolId}
            </span>
            <span className="shrink-0 text-xs text-neutral-500">{danmaku.senderName}</span>
            <span className="break-all" style={{ color: `#${danmaku.color.toString(16).padStart(6, "0")}` }}>
              {danmaku.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
