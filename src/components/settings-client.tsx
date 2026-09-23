"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  qqBound: boolean;
  bgmBound: boolean;
  bgmUsername: string | null;
  /** 是否已配置 OAuth 应用凭据；未配置时只能走个人令牌。 */
  oauthConfigured: boolean;
}

interface ImportJobStats {
  subjects: number;
  episodes: number;
  collections: number;
  progress: number;
}

interface ImportJobView {
  status: "running" | "done" | "failed";
  total: number;
  processed: number;
  stats: ImportJobStats;
  failures: { subjectId: number; reason: string }[];
  failureCount: number;
  lastError: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 绑定 / 解绑 QQ 与 Bangumi，以及分批导入收藏。 */
export default function SettingsClient({
  qqBound,
  bgmBound,
  bgmUsername,
  oauthConfigured,
}: Props) {
  const router = useRouter();
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [token, setToken] = useState("");
  const [binding, setBinding] = useState(false);

  /** 防止重复驱动同一次导入。 */
  const driving = useRef(false);

  /** 挂载时回读既有进度 —— 上次没跑完的任务应能直接看到并续上。 */
  useEffect(() => {
    if (!bgmBound) return;
    let cancelled = false;
    fetch("/api/library/import", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ job?: ImportJobView | null }>)
      .then((body) => {
        if (!cancelled) setJob(body.job ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bgmBound]);

  /**
   * 循环推动导入直至完成。
   *
   * 每次请求只处理一批（服务端 `BATCH_SIZE`），单个 HTTP 请求时长有界；
   * 中途失败不丢进度 —— 服务端游标已持久化，重新点击即从断点继续。
   */
  const driveImport = useCallback(
    async (restart = false) => {
      if (driving.current) return;
      driving.current = true;
      setImporting(true);
      setError(null);

      try {
        let next = true;
        let first = true;

        while (next) {
          const response = await fetch("/api/library/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ restart: restart && first }),
          });
          const body = (await response.json()) as {
            job?: ImportJobView | null;
            error?: string;
            detail?: string;
          };
          first = false;

          if (body.job) setJob(body.job);

          if (!response.ok) {
            throw new Error(
              body.detail
                ? `${body.error ?? "导入失败"}：${body.detail}`
                : (body.error ?? "导入失败"),
            );
          }

          next = body.job?.status === "running";
        }

        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        // 失败后回读一次，展示服务端已持久化的进度
        await fetch("/api/library/import", { cache: "no-store" })
          .then((r) => r.json() as Promise<{ job?: ImportJobView | null }>)
          .then((body) => setJob(body.job ?? null))
          .catch(() => undefined);
      } finally {
        setImporting(false);
        driving.current = false;
      }
    },
    [router],
  );

  const unbind = async (target: "bgm" | "qq") => {
    setError(null);
    try {
      const response = await fetch(`/api/library/import?target=${target}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "解绑失败");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const bindToken = async () => {
    setBinding(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/bgm/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "绑定失败");
      setToken("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBinding(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded border border-neutral-800 p-5">
        <h2 className="font-medium">Bangumi 账号</h2>
        {bgmBound ? (
          <div className="space-y-3 text-sm">
            <p className="text-emerald-400">已绑定：{bgmUsername}</p>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void driveImport(job !== null && job.status !== "done")}
                  disabled={importing || !bgmBound}
                  className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
                >
                  {importing
                    ? `导入中… ${job ? `${job.processed} / ${job.total}` : ""}`
                    : job?.status === "done"
                      ? "重新导入全部收藏与进度"
                      : job && job.processed > 0
                        ? `继续导入（${job.processed} / ${job.total}）`
                        : "一键导入全部收藏与进度"}
                </button>
                <button
                  type="button"
                  onClick={() => void unbind("bgm")}
                  disabled={importing}
                  className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800 disabled:opacity-40"
                >
                  解除绑定
                </button>
              </div>

              {job && <ImportProgress job={job} importing={importing} />}
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-neutral-400">
              绑定后可一键导入你在 Bangumi 的全部收藏、评分与每集观看进度。
            </p>

            <div className="space-y-2">
              <a
                href="/api/auth/bgm/start"
                className="inline-block rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
              >
                用 Bangumi 账号授权登录（推荐）
              </a>
              <p className="text-xs text-neutral-500">
                跳转到 bgm.tv 完成授权。本平台全程不会接触你的 Bangumi 密码。
                {!oauthConfigured && " 当前部署未配置 OAuth 应用，请改用下方个人令牌方式。"}
              </p>
            </div>

            <details className="rounded border border-neutral-800 bg-neutral-900/40 p-4">
              <summary className="cursor-pointer text-neutral-300">
                或者：粘贴个人访问令牌
              </summary>
              <div className="mt-3 space-y-3">
                <ol className="list-decimal space-y-1 pl-5 text-xs text-neutral-400">
                  <li>
                    打开{" "}
                    <a
                      href="https://next.bgm.tv/demo/access-token"
                      target="_blank"
                      rel="noreferrer"
                      className="text-sky-400 underline"
                    >
                      next.bgm.tv/demo/access-token
                    </a>{" "}
                    （需先登录 Bangumi）
                  </li>
                  <li>点击生成，复制得到的令牌</li>
                  <li>粘贴到下方并提交</li>
                </ol>

                <div className="flex flex-wrap gap-2">
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="粘贴 Bangumi 个人访问令牌"
                    autoComplete="off"
                    className="min-w-64 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => void bindToken()}
                    disabled={binding || token.trim().length < 8}
                    className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
                  >
                    {binding ? "校验中…" : "绑定"}
                  </button>
                </div>

                <p className="text-xs text-amber-400/90">
                  该令牌等同于你的 Bangumi 账号密码，仅保存在本站服务端。请勿分享给他人；
                  若怀疑泄露，可在 Bangumi 侧重新生成。
                </p>
              </div>
            </details>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded border border-neutral-800 p-5">
        <h2 className="font-medium">QQ 账号</h2>
        {qqBound ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-emerald-400">已绑定</p>
            <button
              type="button"
              onClick={() => void unbind("qq")}
              className="rounded border border-neutral-700 px-4 py-2 text-sm hover:bg-neutral-800"
            >
              解除绑定
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-neutral-400">绑定 QQ 用于站内通知与社群同步。</p>
            <a
              href="/api/auth/qq/start"
              className="inline-block rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              绑定 QQ
            </a>
          </div>
        )}
      </section>

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 导入进度。把「导入中」这种不可验证的状态，换成可核对的数字：
 * 已处理 / 总数 + 逐项统计 + 失败明细。
 */
function ImportProgress({ job, importing }: { job: ImportJobView; importing: boolean }) {
  const percent = job.total > 0 ? Math.floor((job.processed / job.total) * 100) : 0;
  const done = job.status === "done";

  return (
    <div
      className={`space-y-3 rounded border p-4 ${
        job.status === "failed"
          ? "border-red-900 bg-red-950/30"
          : done
            ? "border-emerald-900 bg-emerald-950/30"
            : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p
          className={`font-medium ${
            job.status === "failed"
              ? "text-red-300"
              : done
                ? "text-emerald-300"
                : "text-sky-300"
          }`}
        >
          {job.status === "failed" ? "导入中断" : done ? "导入完成" : "正在导入"}
        </p>
        <p className="font-mono text-xs text-neutral-400">
          {job.processed} / {job.total}（{percent}%）
        </p>
      </div>

      <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
        <div
          className={`h-full transition-[width] duration-300 ${
            job.status === "failed" ? "bg-red-500" : done ? "bg-emerald-500" : "bg-sky-500"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>

      <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-neutral-300 sm:grid-cols-4">
        <li>条目：{job.stats.subjects}</li>
        <li>章节：{job.stats.episodes}</li>
        <li>收藏：{job.stats.collections}</li>
        <li>进度：{job.stats.progress}</li>
      </ul>

      {job.lastError && job.status === "failed" && (
        <p className="font-mono text-xs text-red-300">{job.lastError}</p>
      )}

      {job.failureCount > 0 && (
        <details className="text-amber-300">
          <summary className="cursor-pointer text-xs">
            {job.failureCount} 个条目导入失败（不影响其余条目）
          </summary>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {job.failures.map((failure) => (
              <li key={failure.subjectId}>
                {failure.subjectId}: {failure.reason}
              </li>
            ))}
            {job.failureCount > job.failures.length && (
              <li className="text-neutral-500">…另有 {job.failureCount - job.failures.length} 条</li>
            )}
          </ul>
        </details>
      )}

      {!done && !importing && job.processed > 0 && (
        <p className="text-xs text-neutral-400">
          进度已保存。可以直接关掉页面，稍后回来点「继续导入」从断点接着跑。
        </p>
      )}
    </div>
  );
}

