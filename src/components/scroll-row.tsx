"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconChevron } from "@/components/icons";

interface Props {
  /** 内层滚动容器的类名（`card-row` / `hero-carousel`），由调用方决定卡片尺寸与间距。 */
  className: string;
  /** 无障碍标签，说明这一行是什么。 */
  label: string;
  /**
   * 每隔多少毫秒自动向「左」推进一格（内容向左挤、右侧进来一张）。
   *
   * 传 `undefined` 关闭。交互过（点击箭头 / 手动滚动 / 悬停 / 聚焦）就**永久**
   * 停止自动推进 —— 用户一旦自己操作，再自动滑动就是抢夺控制权。
   */
  autoAdvanceMs?: number;
  children: React.ReactNode;
}

/**
 * 横向滚动行：带左右半透明箭头的滚动容器。
 *
 * ## 为什么加箭头
 *
 * 原本只有原生滚动条 + 触摸板横滑。在鼠标设备上「这一行还能往右滚」几乎
 * 没有任何提示 —— 滚动条在 mac 上默认隐藏，而卡片恰好停在边缘时看起来
 * 就是「到头了」。箭头把「还有内容」变成显式可见的。
 *
 * ## 几个必须处理的细节
 *
 * - **箭头只在可滚动的方向出现**。已经到最左还显示左箭头，点了没反应，
 *   比没有箭头更让人困惑。用 `scroll` 事件实时更新，而不是只在挂载时判断
 *   （挂载时容器宽度可能是 0，或内容还没渲染完）。
 * - **用 `ResizeObserver` 而不只是 `scroll`**：窗口变宽后可能不再需要滚动，
 *   只在滚动时判断会让箭头一直留着。
 * - **点击后手动重算**：`scrollBy({behavior:"smooth"})` 是异步的，`scroll`
 *   事件会在动画过程中连续触发，因此不能等它 —— 用 `scrollend` 不可靠
 *   （Safari 支持晚），改为在点击后也调一次更新。
 * - 箭头是 `aria-hidden` 的装饰按钮 + 真正的 `aria-label`？这里反过来：
 *   它们是**有功能的按钮**，因此必须可聚焦、有标签，不能当装饰。
 */
export default function ScrollRow({ className, label, autoAdvanceMs, children }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  /** 用户是否已经自己操作过。一旦操作过就不再自动推进。 */
  const userTookOver = useRef(false);
  const [paused, setPaused] = useState(false);

  const update = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // 留 2px 容差：缩放/取整会让 scrollLeft 与 scrollWidth 差零点几像素，
    // 严格比较会让「已到最右」时箭头仍然显示。
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < maxScroll - 2);
  }, []);

  useEffect(() => {
    update();
    const el = scrollerRef.current;
    if (!el) return;

    el.addEventListener(
      "scroll",
      () => {
        update();
        // 只认「用户发起的滚动」以外的信号不可靠，因此配合下面的
        // wheel / touchstart / pointerdown 一起判断 —— 平滑自动滚动
        // 同样会触发 scroll，不能在这里就判定用户接管了。
      },
      { passive: true },
    );
    const takeOver = () => {
      userTookOver.current = true;
    };
    el.addEventListener("wheel", takeOver, { passive: true });
    el.addEventListener("touchstart", takeOver, { passive: true });
    el.addEventListener("pointerdown", takeOver);
    const observer = new ResizeObserver(update);
    observer.observe(el);
    // 内容变化（图片加载完、条目增减）也会改变 scrollWidth
    const mutation = new MutationObserver(update);
    mutation.observe(el, { childList: true, subtree: true });

    return () => {
      el.removeEventListener("wheel", takeOver);
      el.removeEventListener("touchstart", takeOver);
      el.removeEventListener("pointerdown", takeOver);
      observer.disconnect();
      mutation.disconnect();
    };
  }, [update]);

  /** 翻一屏的 80% —— 留一点重叠，读者能接上上一屏的最后一张。 */
  const scrollByPage = useCallback((direction: -1 | 1, smooth = true) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction * el.clientWidth * 0.8,
      behavior: smooth ? "smooth" : "auto",
    });
    // 平滑滚动是异步的，`scroll` 事件还没到 —— 先按目标位置更新一次，
    // 避免「点了箭头但箭头还在」的一瞬。
    window.setTimeout(update, 350);
  }, [update]);

  /**
   * 自动推进：每次向左滚一屏，到底后回到开头。
   *
   * 「每隔一段时间自动向左边挤压，右边进来一个」—— 一屏一屏推进比
   * 「一格一格」更容易看出节奏，也不会让卡片停在半截位置。
   */
  useEffect(() => {
    if (!autoAdvanceMs || paused) return;
    const timer = window.setInterval(() => {
      if (userTookOver.current) return;
      const el = scrollerRef.current;
      if (!el) return;
      const maxScroll = el.scrollWidth - el.clientWidth;
      // 已经到底（或内容不足一屏）就回到开头，循环起来
      if (maxScroll <= 2 || el.scrollLeft >= maxScroll - 2) {
        el.scrollTo({ left: 0, behavior: "smooth" });
      } else {
        el.scrollBy({ left: el.clientWidth * 0.8, behavior: "smooth" });
      }
    }, autoAdvanceMs);
    return () => window.clearInterval(timer);
  }, [autoAdvanceMs, paused]);

  return (
    <div
      className="scroll-row"
      // 悬停暂停：鼠标停在上面时还在自己滑动会让人读不了标题
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      {canScrollLeft && (
        <button
          type="button"
          onClick={() => {
            userTookOver.current = true;
            scrollByPage(-1);
          }}
          aria-label={`${label}：向左滚动`}
          className="scroll-row__arrow scroll-row__arrow--left"
        >
          <IconChevron size={22} direction="left" />
        </button>
      )}

      <div ref={scrollerRef} className={className}>
        {children}
      </div>

      {canScrollRight && (
        <button
          type="button"
          onClick={() => {
            userTookOver.current = true;
            scrollByPage(1);
          }}
          aria-label={`${label}：向右滚动`}
          className="scroll-row__arrow scroll-row__arrow--right"
        >
          <IconChevron size={22} direction="right" />
        </button>
      )}
    </div>
  );
}
