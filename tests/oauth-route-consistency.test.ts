/**
 * OAuth 路由的一致性检查（源码级）。
 *
 * ## 防的是什么
 *
 * BGM 与 QQ 是**两条并列的 OAuth 链路**，各自的 start / callback 结构相同。
 * 缺陷也因此相同 —— 而修一条漏一条是本会话已经发生过两次的形态
 * （`STATUS_LABELS` 重复映射、四个 `parseAirDate` 副本）。
 *
 * 具体到这两个路由，已修过的缺陷是：**把配置错误返回成裸 JSON**：
 *
 *     {"error":"缺少环境变量 QQ_APP_ID / QQ_APP_KEY"}   HTTP 500
 *
 * 用户是从设置页的链接点进来的，看到一页 JSON 报错**没有出路** ——
 * 既不知道发生了什么，也不知道下一步做什么。正确做法是跳回设置页，
 * 并把可操作的原因放进 `reason`（设置页已有渲染逻辑）。
 *
 * 修 BGM 时漏了 QQ（实测两者一个 307、一个 500），因此加这条检查：
 * **四条路径都不得对配置/参数错误返回裸 JSON。**
 *
 * 允许的例外：未登录的 `401` —— 那是接口语义，而用户点的按钮本来就不会
 * 在未登录时渲染。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ROUTES = [
  "src/app/api/auth/bgm/start/route.ts",
  "src/app/api/auth/bgm/callback/route.ts",
  "src/app/api/auth/qq/start/route.ts",
  "src/app/api/auth/qq/callback/route.ts",
];

/** 去掉注释后的源码 —— 注释里提到 `NextResponse.json` 不该算违规。 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("四条 OAuth 路由都不对配置错误返回裸 JSON", () => {
  const offenders: string[] = [];

  for (const route of ROUTES) {
    const source = withoutComments(readFileSync(route, "utf8"));

    for (const match of source.matchAll(/NextResponse\.json\(\s*\{[^}]*error[^}]*\}\s*,\s*\{\s*status:\s*(\d+)/g)) {
      const status = match[1];
      // 401（未登录）是接口语义，允许
      if (status === "401") continue;
      const line = source.slice(0, match.index).split("\n").length;
      offenders.push(`${route}:${line} 返回了 status ${status} 的裸 JSON`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `配置/参数错误应跳回设置页并带 reason，而不是裸 JSON：\n  ${offenders.join("\n  ")}`,
  );
});

test("四条路由都用 resolvePublicOrigin 解析对外地址", () => {
  // 用 `new URL(request.url).origin` 会把用户送到服务器自己的监听地址
  // （实测无视 Host 头），即使用户的浏览器根本不在那台机器上。
  for (const route of ROUTES) {
    const source = withoutComments(readFileSync(route, "utf8"));
    assert.ok(
      source.includes("resolvePublicOrigin"),
      `${route} 没有用 resolvePublicOrigin 解析对外地址`,
    );
  }
});

test("检查器本身有效 —— 注释里的 NextResponse.json 不被误报", () => {
  const sample = `
    // 这里提到 NextResponse.json({ error: "x" }, { status: 500 }) 只是注释
    /* 块注释里也有 NextResponse.json({ error: "y" }, { status: 500 }) */
    return NextResponse.redirect(new URL("/settings?bgm=failed", origin));`;
  const cleaned = withoutComments(sample);
  const hits = [...cleaned.matchAll(/NextResponse\.json\(\s*\{[^}]*error[^}]*\}\s*,\s*\{\s*status:\s*(\d+)/g)];
  assert.equal(hits.length, 0, "注释被误当成代码");
});
