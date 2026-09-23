/**
 * 上游镜像闸门测试。
 *
 * ## 背景：真实事故（2026-09-23）
 *
 * 我用 `curl` 以**用户本人账号**（已绑定 Bangumi）调了 `PUT /api/collections`，
 * body 里带的是测试文案 —— 于是这条测试数据真的写进了用户的 Bangumi 账号，
 * **覆盖了他自己写的短评**。
 *
 * 根因：`collection-actions.ts` 里 `if (bgmBound)` 就直接发请求，**没有任何闸门**。
 * 「拿真实账号做接口冒烟」因此必然污染真实数据。
 *
 * 这组测试锁死两道防护，防止再犯。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decideMirror, logMirrorWrite } from "@/lib/bgm/mirror-guard";

function withMirrorEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.BGM_MIRROR_ENABLED;
  try {
    if (value === undefined) delete process.env.BGM_MIRROR_ENABLED;
    else process.env.BGM_MIRROR_ENABLED = value;
    return fn();
  } finally {
    if (original === undefined) delete process.env.BGM_MIRROR_ENABLED;
    else process.env.BGM_MIRROR_ENABLED = original;
  }
}

/* ---------------------------------------------------------------- *
 * 正常账号放行
 * ---------------------------------------------------------------- */

test("普通账号允许写入上游（功能本身要能用）", () => {
  withMirrorEnv(undefined, () => {
    const decision = decideMirror({ email: "alice@hit.edu.cn" });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, null);
  });
});

/* ---------------------------------------------------------------- *
 * 测试账号自动拒绝 —— 这是「不依赖记忆」的防护
 * ---------------------------------------------------------------- */

test("冒烟账号被自动拒绝（事故的直接原因就是用了真实账号做冒烟）", () => {
  withMirrorEnv(undefined, () => {
    for (const email of [
      "smoke-1790178399881@hit.edu.cn",
      "smoke-other-1790178399963@example.edu",
      "smoke@hit.edu.cn",
    ]) {
      const decision = decideMirror({ email });
      assert.equal(decision.allowed, false, `${email} 应被拒绝`);
      assert.ok(decision.reason, "拒绝时必须给出原因");
    }
  });
});

test("test / e2e 前缀或 +test 后缀的账号被拒绝", () => {
  withMirrorEnv(undefined, () => {
    for (const email of [
      "test-user@hit.edu.cn",
      "test.user@hit.edu.cn",
      "e2e-runner@hit.edu.cn",
      "alice+test@hit.edu.cn",
      "alice-test@hit.edu.cn",
    ]) {
      assert.equal(decideMirror({ email }).allowed, false, `${email} 应被拒绝`);
    }
  });
});

test("拒绝原因里包含账号邮箱（便于排查为什么没同步）", () => {
  withMirrorEnv(undefined, () => {
    const decision = decideMirror({ email: "smoke-123@hit.edu.cn" });
    assert.match(decision.reason ?? "", /smoke-123@hit\.edu\.cn/);
  });
});

test("缺少邮箱时不误判为测试账号（不阻断正常功能）", () => {
  withMirrorEnv(undefined, () => {
    assert.equal(decideMirror({ email: null }).allowed, true);
    assert.equal(decideMirror({ email: undefined }).allowed, true);
    assert.equal(decideMirror({ email: "" }).allowed, true);
  });
});

/* ---------------------------------------------------------------- *
 * 全局开关
 * ---------------------------------------------------------------- */

test("BGM_MIRROR_ENABLED=0 时全部拒绝（含普通账号）", () => {
  withMirrorEnv("0", () => {
    const decision = decideMirror({ email: "alice@hit.edu.cn" });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason ?? "", /BGM_MIRROR_ENABLED/);
  });
});

test("开关只有恰好为 '0' 时才关闭（避免误配 true/false 造成意外）", () => {
  for (const value of ["1", "true", "false", "", "yes"]) {
    withMirrorEnv(value, () => {
      assert.equal(
        decideMirror({ email: "alice@hit.edu.cn" }).allowed,
        true,
        `BGM_MIRROR_ENABLED=${JSON.stringify(value)} 不应关闭镜像`,
      );
    });
  }
});

test("全局开关优先于测试账号判定（运维意图优先）", () => {
  withMirrorEnv("0", () => {
    const decision = decideMirror({ email: "smoke-123@hit.edu.cn" });
    assert.match(decision.reason ?? "", /BGM_MIRROR_ENABLED/, "应报告开关原因而非账号原因");
  });
});

/* ---------------------------------------------------------------- *
 * 审计日志
 * ---------------------------------------------------------------- */

test("logMirrorWrite 把目标与字段打到 stdout（事故时能查「改了什么」）", () => {
  // 这次事故的一个难点就是事后无法从代码或日志看出「写过什么」，
  // 只能靠 grep + 猜时间线。因此审计日志是防护的一部分。
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));

  try {
    logMirrorWrite({
      userId: "u1",
      email: "alice@hit.edu.cn",
      target: "collection",
      subjectId: 101437,
      fields: { type: 2, comment: "x" },
    });
    logMirrorWrite({
      userId: "u1",
      email: "alice@hit.edu.cn",
      target: "episode-progress",
      episodeId: 522,
      fields: { type: 2 },
    });
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, 2);
  assert.match(lines[0], /alice@hit\.edu\.cn/);
  assert.match(lines[0], /subject=101437/);
  assert.match(lines[0], /"comment":"x"/, "必须记下写入的字段内容");
  assert.match(lines[1], /episode=522/);
});
