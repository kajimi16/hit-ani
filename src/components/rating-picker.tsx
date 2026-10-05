"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IconStar } from "@/components/icons";
import { CollectionStatus } from "@/lib/collection";

interface Props {
  subjectId: number;
  /** 当前评分（1–10）；未评为 null。 */
  initialRating: number | null;
  /**
   * 当前的收藏状态。评分是**收藏的属性**，提交时必须带上它 ——
   * 不能自己编一个：那会把用户原本的「看过」改成别的状态。
   * `null` 表示尚未收藏，此时默认记为「在看」（与 Bangumi 站内一致：
   * 打分即视为已收藏）。
   */
  currentStatus: number | null;
  /** 是否已登录 —— 未登录时只读展示。 */
  canInteract: boolean;
}

/**
 * 我的评分（**只打分，不写评论**）。
 *
 * ## 为什么单独做
 *
 * 本项目一直有两个评分字段，但只有一个是可达的：
 * - `Collection.rating`：收藏的属性，**此前没有任何界面能设置它** ——
 *   只能从 Bangumi 导入时带进来；
 * - `Review.rating`：写在评价里，必须先写一段正文。
 *
 * 于是「收藏时顺手打个分」这个 Bangumi 站内最常见的动作在这里做不到 ——
 * 要么写评论，要么不评。这个组件补上它，与 Animeko 的 `updateRating` 对齐。
 *
 * ## 交互取舍
 *
 * 十档星星太挤，用**一排 1–10 的数字按钮**：点一下即提交，点当前值则清除。
 * 比下拉框少一次点击，也比滑杆精确（滑杆在触屏上很难停准）。
 */
export default function RatingPicker({
  subjectId,
  initialRating,
  currentStatus,
  canInteract,
}: Props) {
  const router = useRouter();
  const [rating, setRating] = useState<number | null>(initialRating);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (value: number) => {
    if (!canInteract || pending) return;
    // 点当前值 = 取消评分（与多数平台的星评一致）
    const next = rating === value ? null : value;
    const previous = rating;
    setRating(next); // 乐观更新，失败时回滚
    setPending(true);
    setError(null);

    try {
      /*
       * 必须带 status（评分是收藏的属性，没有收藏就没地方存它），
       * 但**要用已有的状态**：接口是 upsert，`type` 会被无条件写入，
       * 硬编码一个值会把用户的「看过」改成「在看」——这是我在实现时
       * 犯过的错。未收藏时才默认「在看」。
       */
      // 该路由导出的是 PUT（不是 POST）—— 写成 POST 会拿到 405。
      // 与 `collection-picker.tsx` 保持一致。
      const response = await fetch("/api/collections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          status: currentStatus ?? CollectionStatus.Doing,
          rating: next,
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? "保存失败");
      }
      router.refresh();
    } catch (e) {
      setRating(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="detail-section-title">
        我的评分
        {rating !== null && (
          <span className="ml-auto text-xs font-normal text-primary">{rating} 分</span>
        )}
      </h2>

      <div className="flex flex-wrap gap-1" role="group" aria-label="我的评分">
        {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => {
          const active = rating === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => void choose(value)}
              disabled={!canInteract || pending}
              aria-pressed={active}
              aria-label={`打 ${value} 分`}
              className={`min-w-8 rounded-md px-1.5 py-1 font-mono text-xs transition-colors ${
                active
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:bg-secondary-container hover:text-on-secondary-container"
              } disabled:opacity-50`}
            >
              {value}
            </button>
          );
        })}
      </div>

      <p className="mt-2 flex items-center gap-1 text-[0.6875rem] text-on-surface-variant">
        {rating !== null ? (
          <>
            <IconStar size={12} filled />
            再点一次同一个分数可以取消评分。
          </>
        ) : canInteract ? (
          "点一个分数即可评分，不需要写评论。"
        ) : (
          "登录后可以评分。"
        )}
      </p>

      {error && <p className="mt-2 text-xs text-error">{error}</p>}
    </section>
  );
}
