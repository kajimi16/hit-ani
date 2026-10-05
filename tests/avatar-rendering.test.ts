/**
 * 「用户头像不得走 next/image」的源码检查。
 *
 * ## 为什么需要它
 *
 * 这里出过一次真事故：头像功能**邀请用户贴任意 https 直链**，而 `next/image`
 * 要求把主机写进 `next.config.ts` 的 `remotePatterns`（那里只有给封面用的
 * `lain.bgm.tv` / `bgm.tv`）。两者冲突的结果是：
 *
 * - 用户贴 `https://i.imgur.com/x.png`；
 * - 页面照常渲染，但浏览器请求 `/_next/image?url=...` 拿到
 *   **400 `"url" parameter is not allowed`**；
 * - 由于这个组件在根布局的侧栏里，**每一页**的头像都是裂图。
 *
 * 实测确认过允许主机 200、非允许主机 400。修复方式是改用普通 `<img>`
 * （理由见 `user-avatar.tsx` 的注释）。
 *
 * 这条检查防的是「有人觉得 `<img>` 不够优化、又改回 `next/image`」——
 * 那种改动在本地用 BGM 头像测试时**完全正常**（`lain.bgm.tv` 在允许列表里），
 * 只有用户贴第三方链接才会炸。靠人工测试挡不住，得靠规则。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".tsx")) out.push(path);
    }
  };
  walk("src");
  return out;
}

/** 用户可控的头像字段名。 */
const AVATAR_FIELDS = ["avatarUrl", "authorAvatar"];

test("用户头像不得用 next/image 渲染", () => {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const field of AVATAR_FIELDS) {
      // 只看 `src={...field...}` 这种把头像地址交给 next/image 的写法
      const pattern = new RegExp(`src=\\{[^}]*\\b${field}\\b[^}]*\\}`, "g");
      for (const match of source.matchAll(pattern)) {
        const line = source.slice(0, match.index).split("\n").length;
        offenders.push(`${file}:${line} 用 next/image 渲染了 ${field}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `用户头像必须用普通 <img>（任意 https 直链与 next/image 的主机允许列表冲突）：\n  ${offenders.join("\n  ")}`,
  );
});

test("共享的 UserAvatar 组件确实用的是普通 <img>", () => {
  // 上一条只保证「没人把 avatarUrl 直接交给 next/image」——
  // 若 UserAvatar 内部改回 next/image，上一条不会发现（它拿到的是 url prop）。
  const source = readFileSync("src/components/user-avatar.tsx", "utf8");
  assert.ok(source.includes("<img"), "UserAvatar 不再使用普通 <img>");
  assert.equal(
    /from "next\/image"/.test(source),
    false,
    "UserAvatar 引入了 next/image —— 那会让非允许主机的头像裂图",
  );
});

test("扫描确实覆盖到源码（不是扫了空集）", () => {
  const files = sourceFiles();
  assert.ok(files.length > 20, `只扫到 ${files.length} 个 tsx 文件`);
  assert.ok(files.some((f) => f.includes("user-menu")), "没扫到已知渲染头像的文件");
});
