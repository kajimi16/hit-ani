/**
 * OAuth 回调结果 → 用户可见提示的映射测试。
 *
 * ## 防的是什么
 *
 * 绑定 QQ / Bangumi 是跳转式 OAuth：用户去授权页、再被整页重定向回设置页，
 * 结果只能放在 URL 里（`?bgm=ok|failed|taken|denied&reason=…`）。
 *
 * 这些参数此前**没有任何消费者** —— 设置页没读 `searchParams`。用户被送回来
 * 却看不到任何反馈：成功了不知道成功，失败了也不知道为什么。绑定冲突尤其糟，
 * 本站明明有能力说清「这个账号已被另一个账号占用」。
 *
 * 因此这里逐条锁住「每种回调状态都必须产生一条提示」。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOAuthResult } from "@/lib/auth/oauth-result";

test("成功也必须有提示 —— 否则用户不确定到底成功没有", () => {
  const notice = describeOAuthResult({ bgm: "ok" });
  assert.ok(notice);
  assert.equal(notice.tone, "success");
  assert.match(notice.title, /Bangumi/);
  assert.match(notice.title, /成功/);
});

test("绑定冲突要指向可行的下一步", () => {
  const notice = describeOAuthResult({ bgm: "taken" });
  assert.ok(notice);
  assert.equal(notice.tone, "warn");
  assert.match(notice.title, /已经绑定到本站的另一个账号/);
  // BGM 这条路能通过个人令牌 + 确认迁移来自己解决，提示要说出来
  assert.match(notice.detail ?? "", /令牌/);
});

test("QQ 冲突的下一步是「先去解绑」，与 BGM 不同", () => {
  // QQ 是跳转式 OAuth，回调里没有地方确认迁移，所以只能让用户去另一个账号解绑。
  const notice = describeOAuthResult({ qq: "taken" });
  assert.ok(notice);
  assert.match(notice.detail ?? "", /解除绑定/);
});

test("用户主动拒绝授权 —— 这是可自愈的，不该报成错误", () => {
  const notice = describeOAuthResult({ bgm: "denied", reason: "access_denied" });
  assert.ok(notice);
  assert.equal(notice.tone, "warn", "用户自己取消不算系统故障");
  assert.match(notice.title, /被拒绝/);
});

test("失败时把上游给的原因带上", () => {
  const notice = describeOAuthResult({ bgm: "failed", reason: "state 校验失败，请重新发起绑定" });
  assert.ok(notice);
  assert.equal(notice.tone, "error");
  assert.equal(notice.detail, "state 校验失败，请重新发起绑定");
});

test("没有原因时也给一句可读兜底，不留空白", () => {
  const notice = describeOAuthResult({ qq: "failed" });
  assert.ok(notice);
  assert.ok(notice.detail && notice.detail.length > 0);
});

test("没有回调参数时不显示任何提示", () => {
  // 正常打开设置页不该出现一条空横幅。
  assert.equal(describeOAuthResult({}), null);
  assert.equal(describeOAuthResult({ reason: "孤儿原因" }), null);
});

test("未知状态按失败处理，而不是静默忽略", () => {
  // 上游/未来版本可能加新状态；宁可显示一句「失败」，也不要什么反应都没有。
  const notice = describeOAuthResult({ bgm: "something-new" });
  assert.ok(notice);
  assert.equal(notice.tone, "error");
});

test("bgm 与 qq 同时出现时顺序固定，不会随机变", () => {
  const a = describeOAuthResult({ bgm: "ok", qq: "ok" });
  const b = describeOAuthResult({ qq: "ok", bgm: "ok" });
  assert.equal(a?.title, b?.title);
  assert.match(a!.title, /Bangumi/);
});

test("reason 是不可信输入：控制字符与换行被清掉，超长被截断", () => {
  // `reason` 直接来自 URL，任何人都能构造一个链接塞进来。
  const notice = describeOAuthResult({
    bgm: "failed",
    reason: `第一行\n第二行\u0000\r\t  结尾   ${"x".repeat(500)}`,
  });
  assert.ok(notice?.detail);
  assert.equal(/[\n\r\u0000\t]/.test(notice.detail), false, "不该包含控制字符");
  assert.equal(notice.detail.includes("  "), false, "连续空白应折叠");
  assert.ok(notice.detail.length <= 201, `未截断，长度 ${notice.detail.length}`);
});

test("reason 只有空白时按「没有原因」处理", () => {
  const notice = describeOAuthResult({ bgm: "failed", reason: "   \n\t  " });
  assert.ok(notice?.detail);
  assert.match(notice.detail, /重试/, "应退回兜底文案");
});

test("reason 里的 HTML 不被转义成实体（React 会负责转义）", () => {
  // 这里若自作主张转义，用户会看到 `&lt;script&gt;` 这种乱码。
  const notice = describeOAuthResult({
    bgm: "failed",
    reason: "rate limit: <script> & 5 > 3",
  });
  assert.equal(notice?.detail, "rate limit: <script> & 5 > 3");
});
