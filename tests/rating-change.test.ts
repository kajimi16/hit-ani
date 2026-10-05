/**
 * 评分二次确认的文案测试。
 *
 * ## 防的是什么
 *
 * 确认框的价值完全取决于**文案是否说清了后果**。只说「确定吗？」等于
 * 让用户盲签。而这里最容易漏掉的一处是：
 *
 * **未收藏时提交评分会顺带创建一条「在看」收藏** —— 评分是 `Collection`
 * 的属性，没有收藏就没地方存它。用户以为只是打了个分，实际追番里多了一条，
 * 绑定 BGM 时还会镜像到他**真实的 Bangumi 账号**。
 *
 * 文案错漏的后果是用户确认了一件他没同意的事，因此这些分支必须逐个锁住。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRatingChange } from "@/lib/rating-change";

/** 收藏状态：2 = 看过、3 = 在看（映射反直觉，见 `collection.ts`）。 */
const DONE = 2;
const DOING = 3;

test("首次评分（已收藏）：只说打分，不提收藏", () => {
  const change = describeRatingChange(null, 9, DONE);
  assert.equal(change.createsCollection, false);
  assert.match(change.title, /打 9 分/);
  assert.equal(change.detail, null, "已收藏时不该再提「会加入追番」");
});

test("改分：两个分数都要出现，否则用户不知道改了什么", () => {
  const change = describeRatingChange(6, 9, DONE);
  assert.match(change.title, /6 分/, "原分数没出现");
  assert.match(change.title, /9 分/, "新分数没出现");
  assert.match(change.title, /改为/);
});

test("取消评分：措辞是「取消」而不是「改为 0 分」", () => {
  const change = describeRatingChange(6, null, DONE);
  assert.match(change.title, /取消/);
  assert.equal(/0 分/.test(change.title), false, "不该出现「0 分」的说法");
  assert.match(change.title, /6 分/, "应带上被取消的分数");
});

test("点同一个分数 = 取消评分（与星评一致）", () => {
  // 组件里 `stage()` 把「点当前值」翻成 `null`；纯函数这边收到 null 时
  // 必须给出「取消」的文案，而不是「打 6 分」。
  const change = describeRatingChange(6, null, DONE);
  assert.match(change.title, /取消/);
});

test("未收藏时**必须**提醒会顺带创建收藏 —— 这是最易漏的副作用", () => {
  const change = describeRatingChange(null, 9, null);
  assert.equal(change.createsCollection, true);
  assert.ok(change.detail, "未收藏时 detail 不能为空");
  assert.match(change.detail!, /还没有在你的追番里/);
  assert.match(change.detail!, /在看/, "要说清新收藏的状态名");
});

test("未收藏但已有评分（理论上不该出现）也不崩", () => {
  const change = describeRatingChange(5, 9, null);
  assert.equal(change.createsCollection, true);
  assert.match(change.title, /5 分/);
  assert.match(change.title, /9 分/);
});

test("未收藏时取消评分不产生「会创建收藏」的误导提示", () => {
  // 清除评分**不创建任何东西**，此时还提示「会标记为在看」就是错的。
  // （该组合从界面走不到 —— 没有评分就点不出「取消」—— 但函数被复用时
  // 它是个实打实的错误提示。）
  const change = describeRatingChange(null, null, null);
  assert.match(change.title, /清除评分/);
  assert.equal(change.detail, null, "取消评分不该提示会创建收藏");
});

test("已收藏时取消评分同样不提示收藏", () => {
  const change = describeRatingChange(6, null, DONE);
  assert.equal(change.detail, null);
});

test("每一档分数与每一种状态组合都有非空标题", () => {
  // 穷举，确保没有任何组合产生空文案（那会让确认框看起来是空的）。
  for (const current of [null, 1, 5, 10]) {
    for (const next of [null, 1, 5, 10]) {
      for (const status of [null, DOING, DONE]) {
        const change = describeRatingChange(current, next, status);
        assert.ok(
          change.title.length > 0,
          `current=${current} next=${next} status=${status} 得到空标题`,
        );
      }
    }
  }
});
