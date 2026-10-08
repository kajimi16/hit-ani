/**
 * 播放器自绘控件测试。
 *
 * 这些函数每一个出错都**不会报错**，只是「行为有点怪」——正是本项目
 * 反复踩的那一类。因此每条测试都对应一个具体的坏行为。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PLAYER_PREFS,
  DEFAULT_SPEED,
  NEXT_COUNTDOWN_SECONDS,
  SPEED_LADDER,
  clampTime,
  countdownRemaining,
  formatSpeed,
  isTypingTarget,
  nearestSpeedIndex,
  resolveShortcut,
  normalizePlayerPrefs,
  seekTargetFromDrag,
  shouldAutoAdvance,
  stepSpeed,
} from "@/lib/player/controls";

/* ================================================================== *
 * 倍速
 * ================================================================== */

test("倍速按阶梯走，不是每次 ±0.1", () => {
  assert.equal(stepSpeed(1, 1), 1.25);
  assert.equal(stepSpeed(1, -1), 0.75);
});

test("到端点后停住，**不回绕** —— 回绕会让「一直加速」从 3× 跳回 0.5×", () => {
  assert.equal(stepSpeed(SPEED_LADDER[SPEED_LADDER.length - 1], 1), 3);
  assert.equal(stepSpeed(SPEED_LADDER[0], -1), 0.5);
  // 连按多次也稳定在端点
  assert.equal(stepSpeed(stepSpeed(3, 1), 1), 3);
});

test("传入不在阶梯上的值（来自别处/被改写的存储）也能按方向移动", () => {
  // 1.1 最近的档是 1，按加速应到 1.25 —— 而不是「按了没反应」
  assert.equal(stepSpeed(1.1, 1), 1.25);
  assert.equal(stepSpeed(1.1, -1), 0.75);
});

test("非有限值回到默认档，不产生 NaN 倍速", () => {
  assert.equal(stepSpeed(Number.NaN, 1), 1.25);
  assert.equal(nearestSpeedIndex(Number.POSITIVE_INFINITY), SPEED_LADDER.indexOf(DEFAULT_SPEED));
});

test("delta=0 原样返回（幂等）", () => {
  assert.equal(stepSpeed(1.5, 0), 1.5);
});

test("显示格式：整数不带小数，0.5/1.25 保留需要的小数", () => {
  assert.equal(formatSpeed(1), "1×");
  assert.equal(formatSpeed(2), "2×");
  assert.equal(formatSpeed(0.5), "0.5×");
  assert.equal(formatSpeed(1.25), "1.25×");
  assert.equal(formatSpeed(2.5), "2.5×");
});

/* ================================================================== *
 * 快捷键
 * ================================================================== */

test("★ 输入状态下所有快捷键都失效 —— 否则打弹幕会改倍速/暂停视频", () => {
  // 这是安全不变量：弹幕输入框就在同一个组件里，不过滤的话
  // 打「[」改倍速、打空格暂停、打「f」全屏，且**没有任何报错**。
  for (const key of [" ", "k", "ArrowLeft", "ArrowRight", "[", "]", "0", "m", "f"]) {
    assert.equal(resolveShortcut({ key, typing: true }), null, `输入时 ${key} 不该触发动作`);
  }
});

test("input / textarea / select / contenteditable 都算「正在输入」", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
  assert.equal(isTypingTarget({ tagName: "textarea" }), true);
  assert.equal(isTypingTarget({ tagName: "select" }), true);
  // contenteditable 不在 tagName 上 —— 只查 tagName 会漏
  assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "DIV" }), false);
  assert.equal(isTypingTarget(null), false);
});

test("带修饰键的组合不拦（Ctrl+F 查找、Cmd+R 刷新要留给浏览器）", () => {
  assert.equal(resolveShortcut({ key: "f", ctrlKey: true, typing: false }), null);
  assert.equal(resolveShortcut({ key: " ", metaKey: true, typing: false }), null);
  assert.equal(resolveShortcut({ key: "k", altKey: true, typing: false }), null);
});

test("空格与 K 都是播放/暂停；左右是 ±5 秒", () => {
  assert.deepEqual(resolveShortcut({ key: " ", typing: false }), { kind: "toggle-play" });
  assert.deepEqual(resolveShortcut({ key: "k", typing: false }), { kind: "toggle-play" });
  assert.deepEqual(resolveShortcut({ key: "ArrowLeft", typing: false }), {
    kind: "seek-by",
    seconds: -5,
  });
  assert.deepEqual(resolveShortcut({ key: "ArrowRight", typing: false }), {
    kind: "seek-by",
    seconds: 5,
  });
});

test("方括号调速：`[` 减速、`]` 加速；`0` 回到 1×", () => {
  assert.deepEqual(resolveShortcut({ key: "[", typing: false }), { kind: "speed", delta: -1 });
  assert.deepEqual(resolveShortcut({ key: "]", typing: false }), { kind: "speed", delta: 1 });
  assert.deepEqual(resolveShortcut({ key: "0", typing: false }), { kind: "speed-reset" });
});

test("不认识的键返回 null（不拦截，避免吃掉浏览器默认行为）", () => {
  assert.equal(resolveShortcut({ key: "a", typing: false }), null);
  assert.equal(resolveShortcut({ key: "Enter", typing: false }), null);
  assert.equal(resolveShortcut({ key: "Tab", typing: false }), null);
});

/* ================================================================== *
 * 拖动定位
 * ================================================================== */

test("向右拖为快进、向左为后退，且不越过片头/片尾", () => {
  const durationMs = 600_000; // 10 分钟
  assert.equal(seekTargetFromDrag({ startMs: 60_000, dragRatio: 0.5, durationMs }), 105_000);
  assert.equal(seekTargetFromDrag({ startMs: 60_000, dragRatio: -0.5, durationMs }), 15_000);
  // 拖出边界被钳制
  assert.equal(seekTargetFromDrag({ startMs: 1_000, dragRatio: -5, durationMs }), 0);
  assert.equal(seekTargetFromDrag({ startMs: 599_000, dragRatio: 5, durationMs }), durationMs);
});

test("拖动幅度按**视频宽度比例**算，手机上拖一点点不会跳几十秒", () => {
  // 同样「拖动整屏」在两种时长下位移相同（都是 fullWidthSeconds）
  const short = seekTargetFromDrag({ startMs: 0, dragRatio: 1, durationMs: 100_000 });
  const long = seekTargetFromDrag({ startMs: 0, dragRatio: 1, durationMs: 3_600_000 });
  assert.equal(short, long, "位移只取决于拖动比例，不随时长缩放");
});

test("时长为 0（元数据还没到）时不产生 NaN", () => {
  assert.equal(seekTargetFromDrag({ startMs: 5_000, dragRatio: 0.3, durationMs: 0 }), 32_000);
  assert.equal(seekTargetFromDrag({ startMs: Number.NaN, dragRatio: 0.3, durationMs: 0 }), 0);
});

test("clampTime：非有限值与负数都归到合法范围", () => {
  assert.equal(clampTime(-100, 1000), 0);
  assert.equal(clampTime(5000, 1000), 1000);
  assert.equal(clampTime(Number.NaN, 1000), 0);
  // 时长未知时只保证非负
  assert.equal(clampTime(5000, 0), 5000);
  assert.equal(clampTime(5000, Number.NaN), 5000);
});

/* ================================================================== *
 * 自动连播
 * ================================================================== */

test("三个条件缺一不可：开关、有下一集、确实播完", () => {
  assert.equal(shouldAutoAdvance({ enabled: true, hasNext: true, ended: true }), true);
  assert.equal(shouldAutoAdvance({ enabled: false, hasNext: true, ended: true }), false);
  // 最后一集不该去请求不存在的下一集
  assert.equal(shouldAutoAdvance({ enabled: true, hasNext: false, ended: true }), false);
  // 只是暂停/切走，不该把用户拉回去
  assert.equal(shouldAutoAdvance({ enabled: true, hasNext: true, ended: false }), false);
});

test("倒计时剩余秒数不为负 —— `-1s` 会显示在界面上", () => {
  assert.equal(countdownRemaining(0), NEXT_COUNTDOWN_SECONDS);
  assert.equal(countdownRemaining(1_000), NEXT_COUNTDOWN_SECONDS - 1);
  assert.equal(countdownRemaining(NEXT_COUNTDOWN_SECONDS * 1000), 0);
  assert.equal(countdownRemaining(999_999), 0, "超时后应停在 0 而不是负数");
  assert.equal(countdownRemaining(Number.NaN), 0);
});

/* ================================================================== *
 * 偏好持久化
 * ================================================================== */

test("★ 偏好的速度只接受阶梯上的值 —— 越界值会让 playbackRate 抛异常", () => {
  // localStorage 可以被用户改写，`1e9` 这种值赋给 playbackRate 直接抛
  assert.equal(normalizePlayerPrefs({ speed: 1e9 }).speed, 3);
  assert.equal(normalizePlayerPrefs({ speed: -5 }).speed, 0.5);
  // 不在阶梯上 → 归到最近的档，而不是原样保留
  assert.equal(normalizePlayerPrefs({ speed: 1.1 }).speed, 1);
  assert.equal(normalizePlayerPrefs({ speed: 1.3 }).speed, 1.25);
});

test("偏好的非法输入退回默认值，不抛错", () => {
  for (const bad of [null, undefined, 42, "x", []]) {
    assert.deepEqual(normalizePlayerPrefs(bad), DEFAULT_PLAYER_PREFS);
  }
  assert.deepEqual(normalizePlayerPrefs({ speed: Number.NaN }), DEFAULT_PLAYER_PREFS);
  assert.deepEqual(normalizePlayerPrefs({ speed: Number.POSITIVE_INFINITY }), DEFAULT_PLAYER_PREFS);
});

test("★ 布尔只认真布尔 —— 字符串 \"false\" 不能被当成 true", () => {
  // 手工改坏的存储里很常见：`"false"` 是真值，直接透传会让开关反着显示
  assert.equal(normalizePlayerPrefs({ autoNext: "false" }).autoNext, true);
  assert.equal(normalizePlayerPrefs({ autoNext: 0 }).autoNext, true);
  assert.equal(normalizePlayerPrefs({ autoNext: false }).autoNext, false);
  assert.equal(normalizePlayerPrefs({ autoNext: true }).autoNext, true);
});

test("只给部分字段时，其余取默认（与改动前的行为等价：1×）", () => {
  const prefs = normalizePlayerPrefs({ autoNext: false });
  assert.equal(prefs.autoNext, false);
  assert.equal(prefs.speed, DEFAULT_SPEED, "默认倍速必须是 1，与改动前一致");
});
