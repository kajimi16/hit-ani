"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface Props {
  qqBound: boolean;
  bgmBound: boolean;
  bgmUsername: string | null;
  /** 是否已配置 OAuth 应用凭据；未配置时只能走个人令牌。 */
  oauthConfigured: boolean;
}

interface ImportStats {
  subjects: number;
  collections: number;
  created: number;
  updated: number;
}

interface SyncState {
  bound: boolean;
  bgmUsername: string | null;
  syncedAt: string | null;
  collectionCount: number;
  subjectCount: number;
}

/** 绑定 / 解绑 QQ 与 Bangumi，以及分批导入收藏。 */
export default function SettingsClient({
  qqBound,
  bgmBound,
  bgmUsername,
  oauthConfigured,
}: Props) {
  const router = useRouter();
  const [sync, setSync] = useState<SyncState | null>(null);
  const [stats, setStats] = useState<ImportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [token, setToken] = useState("");
  const [binding, setBinding] = useState(false);

  /** 待确认的绑定迁移 —— 非 null 时展示内联确认面板。 */
  const [conflict, setConflict] = useState<{ token: string; bgmUsername: string | null } | null>(
    null,
  );

  const loadSyncState = useCallback(async () => {
    try {
      const response = await fetch("/api/library/import", { cache: "no-store" });
      if (!response.ok) return;
      setSync((await response.json()) as SyncState);
    } catch {
      /* 读不到状态不影响页面可用 */
    }
  }, []);

  useEffect(() => {
    if (bgmBound) void loadSyncState();
  }, [bgmBound, loadSyncState]);

  /**
   * 一键导入。
   *
   * **一次请求完成** —— 导入只写轻量数据（条目骨架 + 收藏关系），
   * 数据全部来自收藏列表内嵌的 `SlimSubject`，因此请求量只有
   * ⌈收藏数 / 100⌉ 次。377 个收藏约 4 次请求、几秒内结束。
   *
   * 完整详情（简介 / 章节 / 单集进度）留到用户打开某个条目时再拉。
   */
  const runImport = async () => {
    setImporting(true);
    setError(null);
    setStats(null);
    try {
      const response = await fetch("/api/library/import", { method: "POST" });
      const body = (await response.json()) as {
        stats?: ImportStats;
        error?: string;
        detail?: string;
      };
      if (!response.ok) {
        throw new Error(
          body.detail ? `${body.error ?? "导入失败"}：${body.detail}` : (body.error ?? "导入失败"),
        );
      }
      setStats(body.stats ?? null);
      await loadSyncState();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

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

  /**
   * 绑定个人令牌。
   *
   * `takeOver` 只在用户**明确确认**后传 true：该 BGM 账号可能已绑定到本站
   * 另一个账号，静默迁移会让那边无声失去绑定，因此先让服务端回 409，
   * 界面再把决定权交给用户（内联确认面板，不用 `window.confirm` —— 后者
   * 样式不可控、移动端表现差，也无法承载「另一方会失去绑定」这种需要
   * 说清楚的后果）。
   */
  const bindToken = async (tokenToUse: string, takeOver = false) => {
    setBinding(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/bgm/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: tokenToUse, takeOver }),
      });
      const body = (await response.json()) as {
        error?: string;
        code?: string;
        bgmUsername?: string | null;
      };

      // 已被另一个账号绑定：说明情况，由用户决定是否迁移
      if (response.status === 409 && body.code === "BGM_ACCOUNT_TAKEN") {
        setConflict({ token: tokenToUse, bgmUsername: body.bgmUsername ?? null });
        return;
      }

      if (!response.ok) throw new Error(body.error ?? "绑定失败");
      setConflict(null);
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
      <section className="panel space-y-3 p-5">
        <h2 className="font-medium">Bangumi 账号</h2>
        {bgmBound ? (
          <div className="space-y-3 text-sm">
            <p className="text-tertiary">已绑定：{bgmUsername}</p>
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void runImport()}
                  disabled={importing || !bgmBound}
                  className="btn btn-primary"
                >
                  {importing
                    ? "导入中…（几秒内完成）"
                    : sync && sync.collectionCount > 0
                      ? "重新导入全部收藏"
                      : "一键导入全部收藏"}
                </button>
                <button
                  type="button"
                  onClick={() => void unbind("bgm")}
                  disabled={importing}
                  className="btn btn-ghost"
                >
                  解除绑定
                </button>
              </div>

              {stats && !importing && (
                <p className="text-xs text-tertiary">
                  导入完成：{stats.collections} 个收藏
                  （新建 {stats.created} · 更新 {stats.updated}）
                </p>
              )}

              {sync?.syncedAt && !importing && (
                <p className="text-xs text-on-surface-variant/70">
                  上次同步 {new Date(sync.syncedAt).toLocaleString("zh-CN")} ·
                  已导入 {sync.collectionCount} 个收藏 ·
                  本地缓存 {sync.subjectCount} 个条目
                  <br />
                  <span className="text-on-surface-variant/70">
                    条目的简介与章节在<strong>首次打开时</strong>才从 Bangumi 拉取并缓存，
                    因此导入很快，也不会为几百个收藏打出上千次请求。
                  </span>
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-on-surface-variant">
              绑定后可一键导入你在 Bangumi 的全部收藏、评分与每集观看进度。
            </p>

            <div className="space-y-2">
              {/*
                未配置 OAuth 时**不给可点的按钮**。

                此前按钮恒可点，而 `readBgmOAuthConfig` 会抛「缺少环境变量」，
                用户点一下就撞上一个裸 JSON 报错页 —— 这正是用户报的
                「授权会报错」。一个必然失败的按钮比没有按钮更糟。
              */}
              {oauthConfigured ? (
                <a href="/api/auth/bgm/start" className="btn btn-primary">
                  用 Bangumi 账号授权登录（推荐）
                </a>
              ) : (
                <button type="button" disabled className="btn btn-primary" title="本部署未配置 Bangumi OAuth 应用">
                  用 Bangumi 账号授权登录（未启用）
                </button>
              )}
              <p className="text-xs text-on-surface-variant">
                {oauthConfigured ? (
                  "跳转到 bgm.tv 完成授权。本平台全程不会接触你的 Bangumi 密码。"
                ) : (
                  <>
                    本部署未配置 Bangumi OAuth 应用（缺 `BGM_CLIENT_ID` /
                    `BGM_CLIENT_SECRET`），因此该方式不可用。请改用下方的
                    <strong className="text-on-surface">个人访问令牌</strong>绑定 —— 功能完全等价。
                  </>
                )}
              </p>
            </div>

            <details className="panel bg-surface-container">
              <summary className="cursor-pointer text-on-surface">
                或者：粘贴个人访问令牌
              </summary>
              <div className="mt-3 space-y-3">
                <ol className="list-decimal space-y-1 pl-5 text-xs text-on-surface-variant">
                  <li>
                    打开{" "}
                    <a
                      href="https://next.bgm.tv/demo/access-token"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
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
                    className="input min-w-64 flex-1 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={() => void bindToken(token.trim())}
                    disabled={binding || token.trim().length < 8}
                    className="btn btn-primary"
                  >
                    {binding ? "校验中…" : "绑定"}
                  </button>
                </div>

                {/*
                  冲突确认：该 BGM 账号已被另一个本地账号绑定。
                  内联面板而不是 `window.confirm` —— 需要说清「另一方会失去绑定」
                  这个后果，而系统弹窗样式不可控、移动端表现也差。
                */}
                {conflict && (
                  <div className="alert alert-warn space-y-2">
                    <p>
                      {conflict.bgmUsername
                        ? `Bangumi 账号「${conflict.bgmUsername}」`
                        : "这个 Bangumi 账号"}
                      已经绑定到本站的另一个账号。
                    </p>
                    <p className="text-xs">
                      如果你就是该 Bangumi 账号的主人（你能提供它的令牌），可以把绑定
                      <strong>迁移</strong>到当前账号。迁移后，原来那个本地账号将不再
                      关联这个 Bangumi 账号。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void bindToken(conflict.token, true)}
                        disabled={binding}
                        className="btn btn-primary btn-sm"
                      >
                        {binding ? "迁移中…" : "迁移到当前账号"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConflict(null)}
                        disabled={binding}
                        className="btn btn-ghost btn-sm"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-xs text-secondary">
                  该令牌等同于你的 Bangumi 账号密码，仅保存在本站服务端。请勿分享给他人；
                  若怀疑泄露，可在 Bangumi 侧重新生成。
                </p>
              </div>
            </details>
          </div>
        )}
      </section>

      <section className="panel space-y-3 p-5">
        <h2 className="font-medium">QQ 账号</h2>
        {qqBound ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-tertiary">已绑定</p>
            <button
              type="button"
              onClick={() => void unbind("qq")}
              className="btn btn-ghost"
            >
              解除绑定
            </button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p className="text-on-surface-variant">绑定 QQ 用于站内通知与社群同步。</p>
            <a
              href="/api/auth/qq/start"
              className="inline-block rounded bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary"
            >
              绑定 QQ
            </a>
          </div>
        )}
      </section>

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}
    </div>
  );
}
