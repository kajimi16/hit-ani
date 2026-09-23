"use client";

import { useCallback, useEffect, useState } from "react";

interface SourceRecord {
  id: string;
  name: string;
  description: string | null;
  factory: string;
  config: Record<string, unknown>;
  enabled: boolean;
  priority: number;
}

interface Preset {
  id: string;
  name: string;
  description: string;
  factory: string;
  config: Record<string, unknown>;
  notes: string;
}

interface SearchItem {
  name: string;
  url: string;
}

interface FeedItem {
  title: string;
  url: string;
  publishedTime: number;
}

interface SourceResult {
  sourceId: string;
  sourceName: string;
  factory: string;
  ok: boolean;
  error: string | null;
  items: SearchItem[];
  feedItems: FeedItem[];
  diagnostics: { matchedElements: number; dropped: { reason: string; sample: string }[] } | null;
}

/** 媒体源的增删改 + 实时试搜。 */
export default function SourceManager() {
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 新建 / 编辑表单
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [factory, setFactory] = useState("web-selector");
  const [configText, setConfigText] = useState("{}");

  // 试搜
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<SourceResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchSummary, setSearchSummary] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/media/sources", { cache: "no-store" });
      const body = (await response.json()) as {
        sources?: SourceRecord[];
        presets?: Preset[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "加载失败");
      setSources(body.sources ?? []);
      setPresets(body.presets ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resetForm = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setFactory("web-selector");
    setConfigText("{}");
  };

  const applyPreset = (preset: Preset) => {
    setEditingId(null);
    setName(preset.name);
    setDescription(preset.description);
    setFactory(preset.factory);
    setConfigText(JSON.stringify(preset.config, null, 2));
    setNotice(`已载入预设「${preset.name}」。${preset.notes} 保存前请确认可访问性。`);
  };

  const startEdit = (source: SourceRecord) => {
    setEditingId(source.id);
    setName(source.name);
    setDescription(source.description ?? "");
    setFactory(source.factory);
    setConfigText(JSON.stringify(source.config, null, 2));
    setNotice(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let config: unknown;
      try {
        config = JSON.parse(configText);
      } catch {
        throw new Error("配置不是合法 JSON");
      }

      const payload = { name, description: description || null, factory, config };
      const response = await fetch(
        editingId ? `/api/media/sources?id=${editingId}` : "/api/media/sources",
        {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json()) as { error?: string; details?: unknown };
      if (!response.ok) {
        throw new Error(
          body.details
            ? `${body.error}：${JSON.stringify(body.details)}`
            : (body.error ?? "保存失败"),
        );
      }
      setNotice(editingId ? "已更新" : "已创建");
      resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (source: SourceRecord) => {
    setError(null);
    try {
      const response = await fetch(`/api/media/sources?id=${source.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !source.enabled }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "操作失败");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (source: SourceRecord) => {
    setError(null);
    try {
      const response = await fetch(`/api/media/sources?id=${source.id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "删除失败");
      }
      if (editingId === source.id) resetForm();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runSearch = async () => {
    if (keyword.trim().length === 0) return;
    setSearching(true);
    setError(null);
    setResults(null);
    setSearchSummary(null);
    try {
      const response = await fetch("/api/media/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword: keyword.trim(), maxResultsPerSource: 10 }),
      });
      const body = (await response.json()) as {
        results?: SourceResult[];
        okCount?: number;
        sourceCount?: number;
        total?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "搜索失败");
      setResults(body.results ?? []);
      setSearchSummary(
        body.sourceCount === 0
          ? "没有启用中的源。请先添加并启用至少一个源。"
          : `${body.okCount}/${body.sourceCount} 个源有响应，共 ${body.total} 条结果`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* ---------------------------------------------------------- 列表 */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">已配置的源</h2>

        {sources.length === 0 ? (
          <p className="rounded border border-neutral-800 p-4 text-sm text-neutral-500">
            还没有配置任何源。可以从下方预设开始，或手工填写配置。
          </p>
        ) : (
          <ul className="space-y-2">
            {sources.map((source) => (
              <li
                key={source.id}
                className="flex flex-wrap items-center gap-3 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-sm"
              >
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    source.enabled
                      ? "bg-emerald-900/60 text-emerald-300"
                      : "bg-neutral-800 text-neutral-500"
                  }`}
                >
                  {source.enabled ? "启用" : "停用"}
                </span>
                <span className="font-medium">{source.name}</span>
                <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
                  {source.factory}
                </span>
                {source.description && (
                  <span className="text-xs text-neutral-500">{source.description}</span>
                )}
                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => startEdit(source)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleEnabled(source)}
                    className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
                  >
                    {source.enabled ? "停用" : "启用"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(source)}
                    className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50"
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------------------------------------------------- 预设 */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">预设起点</h2>

        <div className="space-y-1 rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-400">
          <p className="font-medium text-neutral-300">两类源，用途完全不同</p>
          <p>
            <span className="rounded bg-neutral-800 px-1.5">rss</span> —— BT 站（动漫花园、蜜柑）。
            给的是<strong className="text-amber-300">磁力链接</strong>，需要 qBittorrent
            这类客户端下载，<strong>不能在线看</strong>。
          </p>
          <p>
            <span className="rounded bg-neutral-800 px-1.5">web-selector</span> —— 流媒体站。
            抓的是网页，给出<strong className="text-sky-300">播放页链接</strong>，点开就能看。
            <strong>要「在线看」就必须配这类源。</strong>
          </p>
        </div>

        <p className="text-xs text-neutral-500">
          预设只是模板。站点结构与可用性会变，保存前请先用下方「试搜」验证是否真的能取到数据。
        </p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {presets.map((preset) => (
            <li key={preset.id} className="rounded border border-neutral-800 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">{preset.name}</span>
                <span className="rounded bg-neutral-800 px-2 py-0.5 font-mono text-xs text-neutral-400">
                  {preset.factory}
                </span>
              </div>
              <p className="mt-1 text-xs text-neutral-400">{preset.description}</p>
              <p className="mt-1 text-xs text-amber-400/80">{preset.notes}</p>
              <button
                type="button"
                onClick={() => applyPreset(preset)}
                className="mt-2 rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
              >
                载入到表单
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------------------------------------------------------- 表单 */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">
          {editingId ? "编辑源" : "新建源"}
          {editingId && (
            <button
              type="button"
              onClick={resetForm}
              className="ml-3 text-xs font-normal text-neutral-400 underline"
            >
              取消编辑
            </button>
          )}
        </h2>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="源名称"
              className="min-w-48 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
            <select
              value={factory}
              onChange={(event) => setFactory(event.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
            >
              <option value="web-selector">web-selector（CSS 选择器抓 HTML）</option>
              <option value="rss">rss（RSS / Atom 订阅）</option>
            </select>
          </div>

          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="说明（可选）"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />

          <textarea
            value={configText}
            onChange={(event) => setConfigText(event.target.value)}
            rows={12}
            spellCheck={false}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs outline-none focus:border-sky-500"
          />

          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || name.trim().length === 0}
            className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? "保存中…" : editingId ? "保存修改" : "创建源"}
          </button>
        </div>
      </section>

      {/* ---------------------------------------------------------- 试搜 */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">试搜</h2>
        <p className="text-xs text-neutral-500">
          用关键词测一遍所有启用的源。配置是否正确看这里最快 —— 不用等到用户搜不到才发现。
        </p>
        <div className="flex flex-wrap gap-3">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runSearch();
            }}
            placeholder="例如：反叛的鲁路修"
            className="min-w-64 flex-1 rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />
          <button
            type="button"
            onClick={() => void runSearch()}
            disabled={searching || keyword.trim().length === 0}
            className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            {searching ? "抓取中…" : "试搜"}
          </button>
        </div>

        {searchSummary && <p className="text-sm text-neutral-400">{searchSummary}</p>}

        {results?.map((result) => (
          <div
            key={result.sourceId}
            className={`space-y-2 rounded border p-4 text-sm ${
              result.ok ? "border-neutral-800" : "border-red-900 bg-red-950/20"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{result.sourceName}</span>
              <span
                className={`rounded px-2 py-0.5 text-xs ${
                  result.ok ? "bg-emerald-900/60 text-emerald-300" : "bg-red-900/60 text-red-300"
                }`}
              >
                {result.ok ? "成功" : "失败"}
              </span>
              {result.diagnostics && (
                <span className="text-xs text-neutral-500">
                  命中元素 {result.diagnostics.matchedElements}
                </span>
              )}
            </div>

            {result.error && <p className="text-xs text-red-300">{result.error}</p>}

            {result.items.length > 0 && (
              <ul className="space-y-1 text-xs">
                {result.items.map((item) => (
                  <li key={item.url} className="flex gap-2">
                    <span className="text-neutral-300">{item.name}</span>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate text-sky-400 underline"
                    >
                      {item.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {result.feedItems.length > 0 && (
              <ul className="space-y-1 text-xs">
                {result.feedItems.map((item) => (
                  <li key={item.url}>
                    <span className="text-neutral-300">{item.title}</span>
                    <span className="ml-2 font-mono text-neutral-500">
                      {item.publishedTime
                        ? new Date(item.publishedTime).toISOString().slice(0, 10)
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {result.ok && result.items.length === 0 && result.feedItems.length === 0 && (
              <p className="text-xs text-amber-300">
                抓取成功但没有解析出条目。
                {result.diagnostics && result.diagnostics.matchedElements === 0
                  ? "选择器命中 0 个元素 —— 很可能选择器过期了（站点改版）。"
                  : "可能是关键词在该站无结果，或选择器需要调整。"}
              </p>
            )}

            {result.diagnostics && result.diagnostics.dropped.length > 0 && (
              <details className="text-xs text-amber-300">
                <summary className="cursor-pointer">
                  {result.diagnostics.dropped.length} 个元素被丢弃
                </summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {result.diagnostics.dropped.slice(0, 5).map((drop, index) => (
                    <li key={index}>
                      {drop.reason} — {drop.sample}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))}
      </section>

      {notice && (
        <p className="rounded border border-sky-900 bg-sky-950/30 px-3 py-2 text-sm text-sky-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
