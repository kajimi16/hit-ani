"use client";

import { useState } from "react";
import { COLLECTION_STATUSES, type CollectionStatusValue } from "@/lib/collection";

interface Props {
  subjectId: number;
  /** 当前状态；null = 未收藏。 */
  initialStatus: CollectionStatusValue | null;
  canInteract: boolean;
  bgmBound: boolean;
}

/**
 * 五种收藏状态的选择器。
 *
 * 状态数值的映射来自 `@/lib/collection`（2=看过、3=在看，顺序反直觉）——
 * 界面顺序由 `COLLECTION_STATUSES` 决定，不按数值排序。
 */
export default function CollectionPicker({
  subjectId,
  initialStatus,
  canInteract,
  bgmBound,
}: Props) {
  const [status, setStatus] = useState<CollectionStatusValue | null>(initialStatus);
  const [pending, setPending] = useState<CollectionStatusValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const choose = async (next: CollectionStatusValue) => {
    if (!canInteract || pending !== null) return;

    const previous = status;
    setPending(next);
    setError(null);
    setNotice(null);
    // 乐观更新：先动 UI，失败回滚
    setStatus(next);

    try {
      const response = await fetch("/api/collections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, status: next }),
      });
      const body = (await response.json()) as {
        error?: string;
        bgmSynced?: boolean | null;
        bgmError?: string | null;
        statusLabel?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "保存失败");

      if (body.bgmSynced === false) {
        setNotice(`已在站内标记为「${body.statusLabel}」，但同步到 Bangumi 失败：${body.bgmError}`);
      }
    } catch (e) {
      setStatus(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-neutral-400">收藏状态</span>
        {COLLECTION_STATUSES.map((meta) => {
          const active = status === meta.value;
          return (
            <button
              key={meta.slug}
              type="button"
              onClick={() => void choose(meta.value)}
              disabled={!canInteract || pending !== null}
              className={`rounded border px-3 py-1 text-sm transition disabled:opacity-50 ${
                active
                  ? "border-sky-500 bg-sky-950/60 text-sky-200"
                  : "border-neutral-700 bg-neutral-900 hover:border-neutral-500"
              }`}
            >
              {meta.label}
              {pending === meta.value && <span className="ml-1.5 text-xs">…</span>}
            </button>
          );
        })}
        {status === null && (
          <span className="text-xs text-neutral-500">未收藏</span>
        )}
      </div>

      <p className="text-xs text-neutral-500">
        {canInteract
          ? bgmBound
            ? "标记会同时同步到你的 Bangumi 账号"
            : "标记仅保存在本站（绑定 Bangumi 后可同步）"
          : "登录后可标记收藏状态"}
      </p>

      {notice && (
        <p className="rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
          {notice}
        </p>
      )}
      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
