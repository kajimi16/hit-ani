"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface ReportItem {
  id: string;
  reason: string;
  status: number;
  createdAt: string;
  handledAt: string | null;
  reporter: string;
  danmaku: {
    id: string;
    text: string;
    blocked: boolean;
    playTimeMs: number;
    createdAt: string;
    author: string;
    schoolId: string;
    subjectId: number;
    subjectTitle: string;
    episodeLabel: string;
  };
}

/** `playTimeMs` → `mm:ss`（举报定位到具体时间点才有意义）。 */
function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type Filter = "pending" | "all";

/**
 * 举报处理后台。
 *
 * ## 为什么需要这一页
 *
 * 举报此前**只有写入没有读取** —— 举报进去就没人能看到，功能形同虚设。
 * 学校部署方要能处理违规内容，这是合规刚需。
 *
 * ## 两个动作的差别写在了按钮上
 *
 * 「屏蔽弹幕」会同时把弹幕置为不可见；「驳回」只改举报状态。
 * 只改举报记录而不动弹幕是最容易被误当成修好的做法，所以按钮文案把
 * 后果说清楚，而不是叫「通过 / 拒绝」。
 */
export default function ReportsClient() {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<Filter>("pending");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next: Filter) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/reports?status=${next === "pending" ? "0" : "all"}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as {
        reports?: ReportItem[];
        counts?: Record<string, number>;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "加载失败");
      setReports(body.reports ?? []);
      setCounts(body.counts ?? {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  const handle = async (reportId: string, action: "block" | "dismiss") => {
    setBusyId(reportId);
    setError(null);
    try {
      const response = await fetch("/api/admin/reports", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, action }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "处理失败");
      // 重新拉取 —— 计数与列表都要更新，本地改容易两边不一致
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-5">
      <nav className="flex flex-wrap gap-2">
        {([
          ["pending", `待处理 ${counts["0"] ?? 0}`],
          ["all", "全部"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            aria-current={filter === value ? "true" : undefined}
            className={`rounded border px-3 py-1.5 text-sm transition ${
              filter === value
                ? "border-primary bg-primary-container text-on-primary-container"
                : "border-outline-variant bg-surface-container-low hover:border-outline"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-on-surface-variant">
          已屏蔽 {counts["1"] ?? 0} · 已驳回 {counts["2"] ?? 0}
        </span>
      </nav>

      {error && <p className="alert alert-danger text-sm">{error}</p>}
      {loading && <p className="text-sm text-on-surface-variant">加载中…</p>}

      {!loading && reports.length === 0 && (
        <p className="panel text-sm text-on-surface-variant">
          {filter === "pending" ? "没有待处理的举报。" : "还没有任何举报。"}
        </p>
      )}

      <ul className="space-y-3">
        {reports.map((report) => (
          <li key={report.id} className="panel space-y-3">
            {/* 弹幕本体 + 出处 */}
            <div className="space-y-1">
              <p className="text-sm text-on-surface">「{report.danmaku.text}」</p>
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
                <span>发送者：{report.danmaku.author}</span>
                <span className="badge">{report.danmaku.schoolId}</span>
                <Link
                  href={`/subjects/${report.danmaku.subjectId}`}
                  className="text-primary hover:underline"
                >
                  {report.danmaku.subjectTitle}
                </Link>
                <span>{report.danmaku.episodeLabel}</span>
                <span className="font-mono">{formatTime(report.danmaku.playTimeMs)}</span>
                {report.danmaku.blocked && <span className="badge badge-accent">弹幕已屏蔽</span>}
              </p>
            </div>

            {/* 举报信息 */}
            <div className="rounded border border-outline-variant p-2 text-xs">
              <p>
                <span className="text-on-surface-variant">举报理由：</span>
                {report.reason}
              </p>
              <p className="text-on-surface-variant/70">
                举报人 {report.reporter} ·{" "}
                {new Date(report.createdAt).toLocaleString("zh-CN")}
                {report.handledAt && ` · 已处理于 ${new Date(report.handledAt).toLocaleString("zh-CN")}`}
              </p>
            </div>

            {/* 动作 —— 文案说清后果，不叫「通过 / 拒绝」 */}
            {report.status === 0 ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handle(report.id, "block")}
                  disabled={busyId === report.id}
                  className="btn btn-primary btn-sm"
                >
                  {busyId === report.id ? "处理中…" : "屏蔽这条弹幕"}
                </button>
                <button
                  type="button"
                  onClick={() => void handle(report.id, "dismiss")}
                  disabled={busyId === report.id}
                  className="btn btn-ghost btn-sm"
                >
                  驳回举报（保留弹幕）
                </button>
              </div>
            ) : (
              <p className="text-xs text-on-surface-variant">
                {report.status === 1 ? "已屏蔽该弹幕" : "已驳回（弹幕保留）"}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
