"use client";

import { useCallback, useEffect, useState } from "react";
import SourcePlayer from "@/components/source-player";

interface ExternalResource {
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  episodeNumber: number | null;
  sizeBytes: number | null;
  publishedTime: number;
  isTorrent: boolean;
}

interface ResourceGroup {
  episodeNumber: number | null;
  items: ExternalResource[];
}

interface SourceSummary {
  sourceId: string;
  sourceName: string;
  ok: boolean;
  error: string | null;
  count: number;
  /** 该源能否站内播放（web-selector + 有视频地址正则） */
  playable: boolean;
}

interface Props {
  subjectId: number;
  /** 已配置的抓取源数量；为 0 时提示去配置。 */
  sourceCount: number;
  hasConnections: boolean;
  /** BGM 的剧集，用于把外部源的集数对齐到弹幕 */
  bgmEpisodes: { id: number; sort: number; ep: number | null }[];
  canInteract: boolean;
}

function formatSize(bytes: number | null): string | null {
  // 小于 1 MB 的显示为无意义（「0 MB」），宁可不显示
  if (bytes === null || bytes < 1024 ** 2) return null;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * 外部资源索引。
 *
 * ⚠️ 边界：这里只展示「哪里能找到」，链接由浏览器直接打开。
 * 本平台不代理视频字节、不存储资源（见 docs/MEDIA.md §6.4）。
 */
export default function ExternalResources({
  subjectId,
  sourceCount,
  hasConnections,
  bgmEpisodes,
  canInteract,
}: Props) {
  /** 正在站内播放的源与条目页 */
  const [playingSource, setPlayingSource] = useState<{
    sourceId: string;
    sourceName: string;
    detailUrl: string;
  } | null>(null);

  const [groups, setGroups] = useState<ResourceGroup[] | null>(null);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [cached, setCached] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number | null>>(new Set());
  /** 资源可播性筛选 —— 磁力源和流媒体源的可用性天差地别，必须能分开看。 */
  const [filter, setFilter] = useState<"all" | "playable" | "download">("all");

  const load = useCallback(
    async (refresh = false) => {
      if (sourceCount === 0) return;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/media/resources?subjectId=${subjectId}${refresh ? "&refresh=1" : ""}`,
          { cache: "no-store" },
        );
        const body = (await response.json()) as {
          groups?: ResourceGroup[];
          sources?: SourceSummary[];
          cached?: boolean;
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? "检索失败");
        setGroups(body.groups ?? []);
        setSources(body.sources ?? []);
        setCached(body.cached === true);
        // 默认展开第一组，避免用户还要多一次点击
        const first = body.groups?.[0]?.episodeNumber ?? null;
        setExpanded(new Set([first]));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [subjectId, sourceCount],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (sourceCount === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">外部资源</h2>
        <p className="panel text-sm text-ink-faint">
          还没有配置抓取源。到{" "}
          <a href="/sources" className="text-accent underline">
            媒体源
          </a>{" "}
          页面添加，就能在这里按集看到各站找到的资源。
        </p>
      </section>
    );
  }

  const failedSources = sources.filter((s) => !s.ok);
  /** 支持站内播放的源 id —— 只对这些源显示播放按钮 */
  const playableSources = new Set(sources.filter((s) => s.playable).map((s) => s.sourceId));

  const allResources = groups?.flatMap((g) => g.items) ?? [];
  const playableCount = allResources.filter((r) => !r.isTorrent).length;
  const downloadCount = allResources.filter((r) => r.isTorrent).length;
  const totalResources = allResources.length;

  /** 应用筛选后的分组（保持原有集号顺序，只是过滤条目）。 */
  const visibleGroups = (groups ?? [])
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        filter === "all"
          ? true
          : filter === "playable"
            ? !item.isTorrent
            : item.isTorrent,
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">外部资源</h2>
        {groups !== null && (
          <span className="text-xs text-ink-faint">
            {totalResources} 条 · 来自 {sources.length} 个源
            {cached && "（缓存）"}
          </span>
        )}
        <span className="text-xs text-ink-faint">
          点击在新标签页打开来源站点，本平台不提供也不传输视频
        </span>
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={loading}
          className="btn btn-ghost btn-sm ml-auto"
        >
          {loading ? "检索中…" : "重新检索"}
        </button>
      </div>

      {playingSource && (
        <SourcePlayer
          bgmEpisodes={bgmEpisodes}
          sourceId={playingSource.sourceId}
          sourceName={playingSource.sourceName}
          detailUrl={playingSource.detailUrl}
          canInteract={canInteract}
          onClose={() => setPlayingSource(null)}
        />
      )}

      {/*
        「能不能在线看」是这个面板最该先说清的事。
        实测踩过：配了 BT 源时 24 条资源全是磁力，用户点了半天什么也没发生 ——
        因为他不知道磁力链接浏览器点不了。
      */}
      {groups !== null && totalResources > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={`rounded border px-2 py-1 ${
                filter === "all"
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-line-strong hover:bg-surface-3"
              }`}
            >
              全部 {totalResources}
            </button>
            <button
              type="button"
              onClick={() => setFilter("playable")}
              className={`rounded border px-2 py-1 ${
                filter === "playable"
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-line-strong hover:bg-surface-3"
              }`}
            >
              <span className="text-accent">可在线看</span> {playableCount}
            </button>
            <button
              type="button"
              onClick={() => setFilter("download")}
              className={`rounded border px-2 py-1 ${
                filter === "download"
                  ? "border-accent bg-accent-dim text-accent"
                  : "border-line-strong hover:bg-surface-3"
              }`}
            >
              <span className="text-warn">需下载</span> {downloadCount}
            </button>
          </div>

          {playableCount === 0 && (
            <div className="space-y-1 alert alert-warn">
              <p className="font-medium">
                当前没有「点击就能看」的资源 —— 找到的 {downloadCount} 条都是磁力/种子。
              </p>
              <p>
                磁力链接浏览器点了没用，只能用 qBittorrent 这类软件下载后再播放。
              </p>
              <p>
                {hasConnections
                  ? "你已连接媒体库，可直接用上方的「在这里看」。"
                  : <>
                      要能在线看，请到{" "}
                      <a href="/settings" className="underline">
                        设置
                      </a>{" "}
                      页面连接你自己的 <strong>Jellyfin / Emby</strong> 媒体库；
                      或联系管理员配置指向流媒体站的抓取源。
                    </>}
              </p>
            </div>
          )}
        </div>
      )}

      {loading && groups === null && (
        <p className="text-sm text-ink-faint">
          正在向各源检索…（首次检索较慢，结果会缓存 10 分钟）
        </p>
      )}

      {groups !== null && totalResources > 0 && visibleGroups.length === 0 && (
        <p className="panel text-sm text-ink-faint">
          当前筛选下没有资源。
        </p>
      )}

      {groups !== null && totalResources === 0 && (
        <p className="panel text-sm text-ink-faint">
          各源都没有找到「本条目」的资源。可能是译名差异导致搜不到，
          可以试着调整源的关键词处理方式（媒体源页面里能改）。
        </p>
      )}

      {visibleGroups.map((group) => {
        const key = group.episodeNumber;
        const isOpen = expanded.has(key);
        const label =
          group.episodeNumber === null
            ? `合集 / 无法判定集数（${group.items.length}）`
            : `第 ${group.episodeNumber} 集（${group.items.length}）`;

        return (
          <div key={String(key)} className="rounded border border-line">
            <button
              type="button"
              onClick={() => {
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface"
            >
              <span className="text-ink-muted">{isOpen ? "▾" : "▸"}</span>
              <span className="font-medium">{label}</span>
            </button>

            {isOpen && (
              <ul className="divide-y divide-line border-t border-line">
                {group.items.map((item) => (
                  <li key={`${item.sourceId}:${item.url}`} className="space-y-1 px-3 py-2 text-sm">
                    <p className="break-all text-ink">{item.title}</p>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
                      <span className="rounded bg-surface-3 px-1.5">{item.sourceName}</span>
                      {formatSize(item.sizeBytes) !== null && (
                        <span>{formatSize(item.sizeBytes)}</span>
                      )}
                      {item.publishedTime > 0 && (
                        <span>{new Date(item.publishedTime).toISOString().slice(0, 10)}</span>
                      )}

                      {playableSources.has(item.sourceId) ? (
                        <button
                          type="button"
                          onClick={() =>
                            setPlayingSource({
                              sourceId: item.sourceId,
                              sourceName: item.sourceName,
                              detailUrl: item.url,
                            })
                          }
                          className="rounded border border-accent bg-accent-dim px-1.5 text-accent hover:bg-accent-dim"
                        >
                          站内播放
                        </button>
                      ) : null}

                      {item.isTorrent ? (
                        <>
                          {/*
                            磁力/种子不能「在线看」——浏览器点它只会唤起 BT 客户端。
                            因此不做成链接，改为复制，并在下方说明如何用。
                          */}
                          <span className="rounded bg-warn/10 px-1.5 text-warn">
                            需 BT 客户端
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(item.url);
                            }}
                            className="btn btn-ghost btn-sm"
                          >
                            复制磁力链接
                          </button>
                        </>
                      ) : (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="rounded border border-accent px-1.5 text-accent hover:bg-accent-dim"
                        >
                          打开来源页 ↗
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}

      {failedSources.length > 0 && (
        <details className="alert alert-warn text-xs">
          <summary className="cursor-pointer text-warn">
            {failedSources.length} 个源检索失败（不影响其它源）
          </summary>
          <ul className="mt-2 space-y-1 font-mono text-warn">
            {failedSources.map((source) => (
              <li key={source.sourceId}>
                {source.sourceName}: {source.error}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}
    </section>
  );
}
