"use client";

import { useCallback, useEffect, useState } from "react";
import InlineConfirm from "@/components/inline-confirm";

/**
 * 收藏短评（`Collection.comment`）。
 *
 * 与 `ReviewItem` 是**两个来源**：一个写在 Bangumi 的收藏里（导入带入），
 * 一个写在本站的评论表单里。详情页此前只显示后者，于是「我在 BGM 写的短评」
 * 在详情页找不到 —— 见 `@/lib/review/collection-comments`。
 */
export interface CollectionCommentItem {
  id: string;
  comment: string;
  rating: number | null;
  statusLabel: string;
  authorName: string;
  authorAvatar: string | null;
  schoolId: string;
  isMine: boolean;
  at: string;
}

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

/**
 * 首屏只取几条。
 *
 * 原先这里一次拉 `limit=50` —— 与追番页那个「全量加载」是同一类问题：
 * 评论多的条目要等 50 条一起回来才渲染，首屏白等；而且用户往往只看最新几条。
 * 现在先取最新 `REVIEW_INITIAL_COUNT` 条，其余由「加载更多」按页取。
 */
const REVIEW_INITIAL_COUNT = 2;

/** 「加载更多」每次追加的条数。 */
const REVIEW_PAGE_SIZE = 10;

interface Props {
  subjectId: number;
  canInteract: boolean;
  schoolId?: string;
}

/** 评论 / 影评面板。支持「只看本校」，与弹幕共用同一套 schoolId 边界。 */
export default function ReviewPanel({ subjectId, canInteract, schoolId }: Props) {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  /** 收藏短评 —— 与 `reviews` 分开存，渲染时按时间合并。 */
  const [collectionComments, setCollectionComments] = useState<CollectionCommentItem[]>([]);
  const [total, setTotal] = useState(0);
  const [schoolTotal, setSchoolTotal] = useState(0);
  const [schoolOnly, setSchoolOnly] = useState(false);
  const [kind, setKind] = useState<0 | 1>(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [rating, setRating] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 是否正在等待发布确认。
   *
   * 发布是**不可撤销**的（写进库、所有人可见），而「发布」按钮紧跟在
   * 文本框下方 —— 手机上很容易在收键盘时误触。用户明确要求二次确认。
   */
  const [confirming, setConfirming] = useState(false);

  /**
   * 拉一页评论。
   *
   * `append` 为真时把结果接到已有列表后面（「加载更多」），否则替换
   * （首次加载、切换「只看本校」时重置）。
   */
  const fetchPage = useCallback(
    async (offset: number, append: boolean, overrideLimit?: number) => {
      setLoading(true);
      setError(null);
      try {
        const url = new URL("/api/reviews", window.location.origin);
        url.searchParams.set("subjectId", String(subjectId));
        const limit = overrideLimit ?? (append ? REVIEW_PAGE_SIZE : REVIEW_INITIAL_COUNT);
        url.searchParams.set("limit", String(limit));
        url.searchParams.set("offset", String(offset));
        if (schoolOnly) url.searchParams.set("schoolOnly", "true");

        const response = await fetch(url, { cache: "no-store" });
        const body = (await response.json()) as {
          data?: ReviewItem[];
          total?: number;
          schoolTotal?: number;
          /** 收藏短评 —— 与 `data` 是两个来源，见类型定义处的说明。 */
          collectionComments?: CollectionCommentItem[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? "加载失败");

        setReviews((previous) => (append ? [...previous, ...(body.data ?? [])] : (body.data ?? [])));
        /*
         * 收藏短评**只在首屏取**（不参与分页）—— 一个条目的收藏短评很少超过
         * 几十条，且它们不是本站在管理的 UGC，不需要逐页浏览。
         */
        if (!append) setCollectionComments(body.collectionComments ?? []);
        setTotal(body.total ?? 0);
        setSchoolTotal(body.schoolTotal ?? 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [subjectId, schoolOnly],
  );

  // 首次（以及切换「只看本校」时）只取最新几条 —— 见 REVIEW_INITIAL_COUNT 的说明
  useEffect(() => {
    void fetchPage(0, false);
  }, [fetchPage]);

  /**
   * 当前筛选下的总条数。
   *
   * 必须跟着 `schoolOnly` 走 —— 否则开着「只看本校」时会拿全站总数去比，
   * 「加载更多」永远显示还剩几百条，实际下一页是空的。
   */
  const visibleTotal = schoolOnly ? schoolTotal : total;

  /** 「加载更多」：从当前已显示条数处继续取。 */
  const loadMore = () => void fetchPage(reviews.length, true);

  /**
   * 重新加载，但**保留已展开的条数**。
   *
   * 发完一条评论后直接 `fetchPage(0, false)` 会把列表塌回首屏的两条 ——
   * 用户刚写完评论，正看着下面十几条，结果一下子全没了。新评论在最前
   * （按时间倒序），所以取「当前已显示条数」即可，既保住视野又能看到自己那条。
   */
  const reloadKeepingExpanded = () =>
    void fetchPage(0, false, Math.max(REVIEW_INITIAL_COUNT, reviews.length));

  const submit = async () => {
    if (!content.trim()) return;
    setConfirming(false);
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
      reloadKeepingExpanded();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    /*
     * `id` 是详情页右栏「热门评价 → 全部」的跳转目标。锚点必须落在真正
     * 渲染评论区的那一层，否则点过去只会停在页面顶部（这个链接一度是死的，
     * 因为没有任何元素带这个 id）。
     */
    <section id="reviews" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold">评论 / 影评</h2>
        <span className="text-xs text-on-surface-variant/70">
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
          <span className={canInteract ? "" : "text-on-surface-variant/70"}>只看本校评论</span>
        </label>
      </div>

      {canInteract && (
        <div className="panel space-y-3 bg-surface-container">
          <div className="flex gap-3">
            <select
              value={kind}
              onChange={(event) => setKind(Number(event.target.value) as 0 | 1)}
              className="input w-auto py-1.5"
            >
              <option value={0}>短评</option>
              <option value={1}>长评（影评）</option>
            </select>
            <select
              value={rating}
              onChange={(event) =>
                setRating(event.target.value === "" ? "" : Number(event.target.value))
              }
              className="input w-auto py-1.5"
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
              className="input"
            />
          )}

          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={4}
            placeholder={kind === 1 ? "写一篇影评…" : "写一条短评…"}
            className="input"
          />

          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={content.trim().length === 0 || confirming}
            className="btn btn-primary"
          >
            发布
          </button>
        </div>
      )}

      {/*
        二次确认。发布不可撤销，而按钮就在文本框下方 —— 手机上收键盘时
        容易误触。确认条里写明**是短评还是影评、多少字**，让用户能核对。
      */}
      {confirming && (
        <InlineConfirm
          title={`发布这条${kind === 1 ? "影评" : "短评"}？`}
          detail={`${content.trim().length} 字${rating === "" ? "" : ` · 打 ${rating} 分`}${
            kind === 1 && title.trim() ? ` · 标题「${title.trim()}」` : ""
          }。发布后所有人都能看到，且无法撤回。`}
          confirmLabel="确认发布"
          busy={loading}
          onConfirm={() => void submit()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {error && (
        <p className="alert alert-danger">
          {error}
        </p>
      )}

      <ul className="space-y-3">
        {loading && reviews.length === 0 && collectionComments.length === 0 && (
          <li className="text-sm text-on-surface-variant/70">加载中…</li>
        )}
        {!loading && reviews.length === 0 && collectionComments.length === 0 && (
          <li className="text-sm text-on-surface-variant/70">
            {schoolOnly ? "本校还没有人评论这部番。" : "还没有评论。"}
          </li>
        )}

        {/*
          收藏短评（`Collection.comment`）—— 在 Bangumi 收藏时顺手写的那句话。
          与下面的「本站在建的评论」是两个来源，因此单独一组、标明出处：
          用户此前找不到自己写过的短评，就是因为它们原先只在时光机出现。
          本组永远排在前面（「我的」优先），组内按本站写的在前。
        */}
        {collectionComments.length > 0 && (
          <li className="pt-1 text-xs text-on-surface-variant">
            本站用户在 Bangumi 写的短评
          </li>
        )}
        {collectionComments.map((item) => (
          <li key={item.id} className="panel">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-secondary-container px-1.5 py-0.5 text-on-secondary-container">
                {item.isMine ? "我的短评" : "Bangumi"}
              </span>
              {schoolId && item.schoolId === schoolId && (
                <span className="rounded bg-primary-container/70 px-1.5 py-0.5 text-primary">
                  本校
                </span>
              )}
              <span className="text-on-surface-variant">{item.authorName}</span>
              <span className="text-on-surface-variant/70">{item.statusLabel}</span>
              {item.rating !== null && <span className="text-secondary">{item.rating} 分</span>}
              <span className="ml-auto text-on-surface-variant/70">
                {new Date(item.at).toLocaleDateString("zh-CN")}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-on-surface">{item.comment}</p>
          </li>
        ))}

        {reviews.length > 0 && (
          <li className="pt-1 text-xs text-on-surface-variant">本站评论</li>
        )}
        {reviews.map((review) => (
          <li key={review.id} className="panel">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span
                className={`rounded px-1.5 py-0.5 ${
                  schoolId && review.schoolId === schoolId
                    ? "bg-primary-container/70 text-primary"
                    : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                {review.schoolId === schoolId ? "本校" : review.schoolId}
              </span>
              <span className="text-on-surface-variant">{review.authorName}</span>
              <span className="text-on-surface-variant/70">
                {review.kind === 1 ? "影评" : "短评"}
              </span>
              {review.rating !== null && (
                <span className="text-secondary">{review.rating} 分</span>
              )}
              <span className="ml-auto text-on-surface-variant/70">
                {new Date(review.createdAt).toLocaleString("zh-CN")}
              </span>
            </div>
            {review.title && (
              <p className="mt-2 font-medium text-on-surface">{review.title}</p>
            )}
            <p className="mt-1 whitespace-pre-wrap text-sm text-on-surface">
              {review.content}
            </p>
          </li>
        ))}
      </ul>

      {/*
        「加载更多」——首屏只取最新的 2 条，其余按页追加。
        按钮上写明还剩多少，用户点之前就知道要付出什么。
      */}
      {reviews.length > 0 && reviews.length < visibleTotal && (
        <button
          type="button"
          onClick={loadMore}
          disabled={loading}
          className="btn btn-ghost w-full"
        >
          {loading
            ? "加载中…"
            : `加载更多（已显示 ${reviews.length} / ${visibleTotal}）`}
        </button>
      )}
    </section>
  );
}
