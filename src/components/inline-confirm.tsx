"use client";

interface Props {
  /** 一句话主文案：说清这次操作会**改变什么**。 */
  title: string;
  /** 补充说明（副作用等）；无需补充时不传。 */
  detail?: string | null;
  /** 确认按钮文案。 */
  confirmLabel?: string;
  /** 提交中：两个按钮都禁用，避免重复提交。 */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 内联二次确认条。
 *
 * ## 为什么不用 `window.confirm`
 *
 * 本项目在 OAuth 绑定冲突那次已经做过同样的取舍（见 `settings-client.tsx`）：
 * 系统弹窗**样式不可控、移动端表现差**，而且无法承载需要说清楚的后果
 * （「会同时在追番里加一条『在看』」这类信息塞进原生 confirm 很难读）。
 *
 * ## 为什么是「点一次暂存、点第二次确认」而不是弹窗
 *
 * 评分按钮是一排 10 个紧挨着的数字 —— 误触的典型形态是**点错相邻一格**。
 * 把它做成「第一次点击只是暂存，界面上明确显示将要做什么，第二次才写入」，
 * 既拦住了误触，又不会像模态框那样打断视线。
 *
 * `role="alertdialog"` + `aria-live` 让屏幕阅读器也立刻知道出现了确认请求。
 */
export default function InlineConfirm({
  title,
  detail,
  confirmLabel = "确认",
  busy = false,
  onConfirm,
  onCancel,
}: Props) {
  return (
    <div
      role="alertdialog"
      aria-live="polite"
      className="alert alert-warn flex flex-wrap items-center gap-x-3 gap-y-2 text-xs"
    >
      <div className="min-w-0">
        <p className="font-medium text-on-surface">{title}</p>
        {detail && <p className="mt-0.5 text-on-surface-variant">{detail}</p>}
      </div>

      <div className="ml-auto flex shrink-0 gap-2">
        <button type="button" onClick={onConfirm} disabled={busy} className="btn btn-primary btn-sm">
          {busy ? "提交中…" : confirmLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn-ghost btn-sm">
          取消
        </button>
      </div>
    </div>
  );
}
