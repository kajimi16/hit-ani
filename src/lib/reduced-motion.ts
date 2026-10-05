/**
 * 「减少动态效果」偏好。
 *
 * ## 为什么 CSS 那一半不够
 *
 * `globals.css` 里已经有关掉装饰性动效的 `@media (prefers-reduced-motion: reduce)`
 * 块，但那只覆盖 **CSS 驱动的**动效。JS 驱动的动效完全绕开媒体查询：
 *
 * - `ScrollRow` 每 6 秒把内容整体向左推一屏 —— 这是页面上**最显著**的位移；
 * - 箭头按钮用 `behavior: "smooth"` 滚动，也是一段持续几百毫秒的位移。
 *
 * 两者对前庭敏感的用户恰恰是最难受的，因此 JS 侧必须自己判断这个偏好。
 *
 * ## 为什么订阅而不是只读一次
 *
 * 用户可以在系统设置里随时打开「减少动态效果」，不需要刷新页面 ——
 * 只读一次会让新设置到下次刷新才生效，而在此之前内容仍在自动滑动。
 * 反过来（先开着、用户在浏览中关掉）同样应该立即恢复。
 */

/** 媒体查询字符串。集中在此，避免各处各写一份后拼错。 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * 把「是否减少动效」翻译成滚动行为。
 *
 * 抽成纯函数是为了能直接测：`smooth` 与 `auto` 的区别在测试里无法观察
 * （jsdom 不实现平滑滚动），但**映射本身**可以被断言。
 */
export function scrollBehavior(reduceMotion: boolean): ScrollBehavior {
  return reduceMotion ? "auto" : "smooth";
}

/**
 * 订阅偏好变化。
 *
 * 返回退订函数。抽出来是为了 `useSyncExternalStore` 能复用它 ——
 * 那比 `useEffect` + `useState` 更不容易出「服务端/客户端首帧不一致」的问题。
 */
export function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/**
 * 当前偏好。
 *
 * 服务端渲染时返回 `false`（不减少）—— 服务端无从得知，而 `false` 与
 * 现有的默认行为一致，不会造成水合前后不一致的可见差异。真实的偏好会在
 * 客户端首帧后立刻由 `useSyncExternalStore` 取到。
 */
export function readReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
