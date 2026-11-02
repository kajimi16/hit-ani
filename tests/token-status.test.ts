/**
 * Bangumi 令牌状态与「过期」判定的测试。
 *
 * ## 为什么这两件事都要测
 *
 * 用户报的问题是「令牌过期后没有更新入口」——界面缺陷。顺着查还发现第二个：
 * `isBgmTokenExpiring` 是「24 小时内到期」的**刷新窗口**，但个人令牌没有
 * refresh_token 可换，套上它等于「令牌还剩 23 小时就导不进来」，而报错文案
 * 说的是「已过期」（不实）。两个缺陷都会让用户以为自己的账号出了别的问题。
 *
 * 这里把边界钉死：**将过期 ≠ 已过期**。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isBgmTokenExpired, isBgmTokenExpiring, planTokenUse } from "@/lib/auth/bgm-oauth";
import { TOKEN_WARN_MS, bgmTokenStatus } from "@/lib/auth/token-status";

const NOW = 1_800_000_000_000; // 固定时间点，避免依赖真实时钟
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/* ================================================================== *
 * 展示状态：三个边界
 * ================================================================== */

test("没有过期时间时不提示用户（`unknown` 不渲染任何警告）", () => {
  for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const info = bgmTokenStatus(bad as number | null, NOW);
    assert.equal(info.status, "unknown", `输入 ${String(bad)} 不应被当成有效时间`);
    assert.equal(info.daysLeft, null);
  }
});

test("★ 已经过期：status=expired，不是 expiring", () => {
  for (const offset of [-1, -1 * HOUR, -30 * DAY]) {
    const info = bgmTokenStatus(NOW + offset, NOW);
    assert.equal(info.status, "expired", `offset=${offset}`);
  }
  // 恰好等于现在也算过期（不能再用）
  assert.equal(bgmTokenStatus(NOW, NOW).status, "expired");
});

test("★ 24 小时以内：expiring（提醒更新），不是 expired", () => {
  for (const offset of [1, HOUR, TOKEN_WARN_MS - 1]) {
    const info = bgmTokenStatus(NOW + offset, NOW);
    assert.equal(info.status, "expiring", `剩 ${offset}ms 应提醒但不算过期`);
  }
});

test("超过 24 小时：ok", () => {
  const info = bgmTokenStatus(NOW + TOKEN_WARN_MS + 1, NOW);
  assert.equal(info.status, "ok");
});

test("daysLeft 向上取整：剩 1 分钟 ≠ 剩 0 天", () => {
  // 向上取整的意义：不能让「还有 1 分钟」显示成「还有 0 天」
  assert.equal(bgmTokenStatus(NOW + 60_000, NOW).daysLeft, 1);
  assert.equal(bgmTokenStatus(NOW + 5 * DAY, NOW).daysLeft, 5);
  assert.equal(bgmTokenStatus(NOW + 5 * DAY + 1, NOW).daysLeft, 6);
});

/* ================================================================== *
 * 后端判定：个人令牌只在**真的**过期时失败
 * ================================================================== */

test("★ 两个判定的差异就是那个 bug：剩 23 小时 → 将过期，但**未**过期", () => {
  const expiresAt = new Date(NOW + 23 * HOUR);
  assert.equal(isBgmTokenExpiring(expiresAt, NOW), true, "24h 窗口内算「将过期」");
  assert.equal(
    isBgmTokenExpired(expiresAt, NOW),
    false,
    "个人令牌剩 23 小时必须仍然可用 —— 此前这里被判成过期，用户提前一天导不进来",
  );
});

test("isBgmTokenExpired 的边界：现在及以前为过期，之后为未过期", () => {
  assert.equal(isBgmTokenExpired(new Date(NOW), NOW), true, "恰好到期即不可用");
  assert.equal(isBgmTokenExpired(new Date(NOW - 1), NOW), true);
  assert.equal(isBgmTokenExpired(new Date(NOW + 1), NOW), false);
});

test("两个判定在「已过期」上一致（不会出现一个说过期、一个说没过期）", () => {
  for (const offset of [-DAY, -1, 0]) {
    const expiresAt = new Date(NOW + offset);
    assert.equal(isBgmTokenExpiring(expiresAt, NOW), true);
    assert.equal(isBgmTokenExpired(expiresAt, NOW), true);
  }
});

/* ================================================================== *
 * 决策规则（`getFreshBgmAccessToken` 真正走的路径）
 * ================================================================== */

test("★ 个人令牌剩 23 小时 → use（必须仍可用，不能提前报废）", () => {
  const plan = planTokenUse({ personalToken: true, expiresAt: new Date(NOW + 23 * HOUR) }, NOW);
  assert.equal(plan, "use", "这条正是用户撞上的 bug：提前一天导不进来");
});

test("个人令牌真的过期 → expired", () => {
  for (const offset of [-DAY, -1, 0]) {
    const plan = planTokenUse({ personalToken: true, expiresAt: new Date(NOW + offset) }, NOW);
    assert.equal(plan, "expired", `offset=${offset}`);
  }
});

test("个人令牌有效期充足 → use", () => {
  assert.equal(
    planTokenUse({ personalToken: true, expiresAt: new Date(NOW + 30 * DAY) }, NOW),
    "use",
  );
});

test("OAuth 绑定临近过期 → refresh（它**应该**提前续期）", () => {
  for (const offset of [HOUR, TOKEN_WARN_MS - 1]) {
    assert.equal(
      planTokenUse({ personalToken: false, expiresAt: new Date(NOW + offset) }, NOW),
      "refresh",
      `OAuth 剩 ${offset}ms 应续期`,
    );
  }
});

test("OAuth 绑定有效期充足 → use；已过期 → refresh（尝试续期）", () => {
  assert.equal(
    planTokenUse({ personalToken: false, expiresAt: new Date(NOW + 30 * DAY) }, NOW),
    "use",
  );
  // OAuth 过期后仍应尝试 refresh —— 由 refresh_token 决定成败，而不是直接判死
  assert.equal(
    planTokenUse({ personalToken: false, expiresAt: new Date(NOW - DAY) }, NOW),
    "refresh",
  );
});
