"use client";

import { useCallback, useEffect, useState } from "react";

export interface ReviewItem {
  id: string;
  kind: number;
  title: string | null;
  content: string;
  rating: number | null;
  schoolId: string;
  authorName: string;
  likes: number;
  createdAt: string;
}

interface Props {
  subjectId: number;
  canInteract: boolean;
  schoolId?: string;
}

/** 评论 / 影评面板。支持「只看本校」，与弹幕共用同一套 schoolId 边界。 */
export default function ReviewPanel({ subjectId, canInteract, schoolId }: Props) {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [schoolTotal, setSchoolTotal] = useState(0);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [kind, setKind] = useState<0 | 1>(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [rating, setRating] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/reviews", window.location.origin);
      url.searchParams.set("subjectId", String(subjectId));
      url.searchParams.set("limit", "50");
      if (schoolOnly) url.searchParams.set("schoolOnly", "true");

      const response = await fetch(url, { cache: "no-store" });
      const body = (await response.json()) as {
        data?: ReviewItem[];
        total?: number;
        schoolTotal?: number;
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "加载失败");

      setReviews(body.data ?? []);
      setTotal(body.total ?? 0);
      setSchoolTotal(body.schoolTotal ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [subjectId, schoolOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    if (!content.trim()) return;
    setError(null);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          kind,
          title: kind === 1 ? title.trim() || null : null,
          content: content.trim(),
          rating: rating === "" ? null : Number(rating),
        }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "发布失败");
      setTitle("");
      setContent("");
      setRating("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">评论 / 影评</h2>
        <span className="text-xs text-neutral-500">
          全体 {total} · 本校 {schoolTotal}
        </span>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={schoolOnly}
            disabled={!canInteract}
            onChange={(event) => setSchoolOnly(event.target.checked)}
            className="size-4 accent-sky-500"
          />
          <span className={canInteract ? "" : "text-neutral-600"}>只看本校评论</span>
        </label>
      </div>

      {canInteract && (
        <div className="space-y-3 rounded border border-neutral-800 bg-neutral-900/40 p-4">
          <div className="flex gap-3">
            <select
              value={kind}
              onChange={(event) => setKind(Number(event.target.value) as 0 | 1)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
            >
              <option value={0}>短评</option>
              <option value={1}>长评（影评）</option>
            </select>
            <select
              value={rating}
              onChange={(event) =>
                setRating(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm"
            >
              <option value="">不打分</option>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((score) => (
                <option key={score} value={score}>
                  {score} 分
                </option>
              ))}
            </select>
          </div>

          {kind === 1 && (
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="影评标题"
              className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
            />
          )}

          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            placeholder={kind === 1 ? "写一篇影评…" : "写一条短评…"}
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-sky-500"
          />

          <button
            type="button"
            onClick={() => void submit()}
            disabled={content.trim().length === 0}
            className="rounded bg-sky-600 px-5 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-40"
          >
            发布
          </button>
        </div>
      )}

      {error && (
        <p className="rounded border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {loading && <li className="text-sm text-neutral-500">加载中…</li>}
        {!loading && reviews.length === 0 && (
          <li className="text-sm text-neutral-500">
            {schoolOnly ? "本校还没有人评论这部番。" : "还没有评论。"}
          </li>
        )}
        {reviews.map((review) => (
          <li key={review.id} className="rounded border border-neutral-800 p-4">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  schoolId && review.schoolId === schoolId
                    ? "bg-sky-900/70 text-sky-300"
                    : "bg-neutral-800 text-neutral-400"
                }`}
              >
                {review.schoolId === schoolId ? "本校" : review.schoolId}
              </span>
              <span className="text-neutral-400">{review.authorName}</span>
              <span className="text-neutral-600">
                {review.kind === 1 ? "影评" : "短评"}
              </span>
              {review.rating !== null && (
                <span className="text-amber-400">{review.rating} 分</span>
              )}
              <span className="ml-auto text-neutral-600">
                {new Date(review.createdAt).toLocaleString("zh-CN")}
              </span>
            </div>
            {review.title && (
              <p className="mt-2 font-medium text-neutral-100">{review.title}</p>
            )}
            <p className="mt-1 whitespace-pre-wrap text-sm text-neutral-300">
              {review.content}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
