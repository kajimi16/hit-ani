"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevron } from "@/components/icons";

interface Props {
  text: string;
}

/**
 * 收起状态显示几行。必须与 `globals.css` 里 `.summary-collapse__body` 的
 * `max-height: 9.6em`（= 6 行 × 1.6）一致 —— 这里只用于「判断是否需要折叠」，
 * 真正的截断仍由 CSS 完成。
 */
const COLLAPSED_LINES = 6;

/**
 * 可折叠的简介。
 *
 * ## 为什么需要 JS 判断，而不是纯 CSS
 *
 * 第一版是纯 CSS：`max-height` 截断 + 底部渐隐遮罩 + 常驻的展开按钮。
 * 问题是**大部分条目的简介并不长**（实测本库最长只有 307 字），于是：
 * - 底部渐隐会把**完整可见**的最后一行淡化，读起来像被截断了；
 * - 展开按钮点了没有任何变化 —— 用户会以为坏了。
 *
 * CSS 判断不了「内容是否溢出容器」，所以这里挂载后量一次
 * `scrollHeight` 与 `clientHeight`，只有真的溢出时才启用截断、遮罩与按钮。
 *
 * 用 `ResizeObserver` 而不是只量一次：窗口变宽后可能就不需要截断了
 * （那时按钮与遮罩都该消失）。
 */
export default function CollapsibleSummary({ text }: Props) {
  const bodyRef = useRef<HTMLParagraphElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;

    /*
     * 与「6 行的实际像素高」比较，而不是 `scrollHeight > clientHeight`。
     *
     * 后者是**循环依赖**：`.summary-collapse__body` 的 `max-height` 只在
     * `data-overflowing="true"` 时才应用，而那时它还没被标上 —— 于是
     * `clientHeight` 等于 `scrollHeight`，永远测不出溢出（实测确认：
     * 182px 的长简介也被判为不溢出）。
     *
     * 行高从计算样式里读，避免把 1.6 这个系数在 CSS 与 JS 里各写一份。
     */
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      const limit = Number.isFinite(lineHeight) ? lineHeight * COLLAPSED_LINES : 0;
      setOverflowing(limit > 0 && element.scrollHeight > limit + 1);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <details className="summary-collapse group" data-overflowing={overflowing ? "true" : undefined}>
      <p ref={bodyRef} className="summary-collapse__body whitespace-pre-wrap text-sm leading-relaxed text-on-surface-variant">
        {text}
      </p>

      {/*
        只有真的溢出时才渲染展开按钮。不溢出时连按钮都不出现 ——
        「点了没反应」比没有按钮更糟。
      */}
      {overflowing && (
        <summary className="summary-collapse__toggle btn btn-ghost btn-sm mt-2 w-full">
          <span className="group-open:hidden">展开全部简介</span>
          <span className="hidden group-open:inline">收起简介</span>
          <IconChevron size={16} className="summary-collapse__chevron" />
        </summary>
      )}
    </details>
  );
}
