/**
 * 「减少动态效果」偏好测试。
 *
 * ## 防的是什么
 *
 * CSS 里的 `@media (prefers-reduced-motion: reduce)` 只覆盖 CSS 驱动的动效，
 * **JS 驱动的位移完全绕开它**。本项目里最显著的一处就是 `ScrollRow`：
 * 每 6 秒把整行内容推一屏 —— 对前庭敏感的用户正是最难受的东西，
 * 而它恰好是最容易被漏掉的一处（写 CSS 时想到了，写 JS 时忘了）。
 *
 * 因此这里锁住两件事：
 * 1. 偏好 → 滚动行为的**映射**正确；
 * 2. 组件源码里**确实**引用了这个偏好（源码级检查）—— 行为测试无法覆盖
 *    「自动轮播有没有被关掉」，因为那需要真实的浏览器与计时器。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REDUCED_MOTION_QUERY, readReducedMotion, scrollBehavior } from "@/lib/reduced-motion";

test("偏好开启时用瞬时跳转，关闭时用平滑滚动", () => {
  assert.equal(scrollBehavior(true), "auto");
  assert.equal(scrollBehavior(false), "smooth");
});

test("映射只有两种可能，不存在其它取值", () => {
  // 调用方把它直接交给 `scrollBy({behavior})`，多一种取值就是运行时错误。
  for (const input of [true, false]) {
    const value = scrollBehavior(input);
    assert.ok(value === "auto" || value === "smooth", `得到 ${String(value)}`);
  }
});

test("媒体查询字符串与 CSS 里的写法一致", () => {
  // 两处不一致时偏好会在 CSS 生效而 JS 不生效（或反之），且都不报错。
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.ok(
    css.includes(`@media ${REDUCED_MOTION_QUERY}`),
    `globals.css 里没有 @media ${REDUCED_MOTION_QUERY} —— 与 JS 侧的查询不一致`,
  );
});

test("服务端（无 window）时返回 false，不抛错", () => {
  // 首帧会在服务端渲染，此时没有 matchMedia。
  const originalWindow = globalThis.window;
  // @ts-expect-error 测试里故意临时移除 window
  delete globalThis.window;
  try {
    assert.equal(readReducedMotion(), false);
  } finally {
    if (originalWindow !== undefined) globalThis.window = originalWindow;
  }
});

/* ---------------------------------------------------------------- *
 * 源码级检查
 * ---------------------------------------------------------------- */

test("ScrollRow 必须引用减少动效偏好 —— 否则自动轮播会无视它", () => {
  // 这条是本文件存在的核心理由：上一版 `scroll-row.tsx` 每个 6 秒推一屏，
  // 却完全没有 `matchMedia`，而所有测试都是绿的。
  const source = readFileSync("src/components/scroll-row.tsx", "utf8");
  assert.ok(
    source.includes("readReducedMotion") && source.includes("subscribeReducedMotion"),
    "ScrollRow 没有接入减少动效偏好",
  );
});

test("自动轮播在减少动效时必须提前返回（不是改成瞬移）", () => {
  // 「内容自己在动」本身就是问题，与动画是否平滑无关。
  //
  // 断言的是**顺序**而不是「文件里存在这句话」：提前返回必须在
  // `setInterval` **之前**，否则计时器已经建好，返回也拦不住。
  // （锚在具体变量名上会很脆 —— 上一版就因为锚点写错而误报。）
  const source = readFileSync("src/components/scroll-row.tsx", "utf8");
  const guard = source.indexOf("if (reduceMotion) return;");
  const interval = source.indexOf("window.setInterval");

  assert.ok(guard > 0, "没有找到减少动效的提前返回");
  assert.ok(interval > 0, "没有找到自动轮播的 setInterval");
  assert.ok(
    guard < interval,
    "提前返回出现在 setInterval 之后 —— 计时器已经建好，返回拦不住自动轮播",
  );
});

test("箭头滚动用 scrollBehavior(reduceMotion)，而不是写死 smooth", () => {
  const source = readFileSync("src/components/scroll-row.tsx", "utf8");
  assert.ok(
    source.includes("behavior: scrollBehavior(reduceMotion)"),
    "箭头滚动写死了 smooth，会无视偏好",
  );
});
