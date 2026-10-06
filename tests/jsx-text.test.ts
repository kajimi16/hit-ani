/**
 * JSX 文本里不得出现 Markdown 加粗标记。
 *
 * ## 防的是什么
 *
 * `**不会保存**` 这种写法在 **注释里**是对的（Markdown 风格强调），
 * 但写在 **JSX 文本节点里**会**原样渲染** —— 用户看到的是
 * 「密码仅用于换取访问令牌，\*\*不会保存\*\*」两个星号。
 *
 * 这个错误在本项目出现过**三次**（注册页说明、Jellyfin 凭据提示、
 * 收藏导入说明），都是同一个模式：注释里用惯了 `**`，写文案时顺手也写。
 * 没有报错、不影响类型、测试全绿，只有人眼看得见。
 *
 * ## 为什么必须剥离注释再扫
 *
 * 全仓 `**` 的出现大部分是**合法**的：
 * - JSDoc / 行注释里的强调（几百处）；
 * - 幂运算 `1024 ** 3`。
 *
 * 第一版检测脚本没剥离注释，报出 115 处「命中」——**全是误报**。
 * 真正命中的只有 2 处。检测器写错比不写更糟：它会让人忽略这个检查。
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 把 `/* … *​/` 与 `// …` 全部替换为空白，**保留行号**。
 *
 * 字符串字面量也要跳过 —— 否则 `"/*"` 这类内容会让状态机错位。
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  const n = source.length;
  let i = 0;

  const blank = (chunk: string) =>
    out.push([...chunk].map((c) => (c === "\n" ? "\n" : " ")).join(""));

  while (i < n) {
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out.push(" ".repeat(stop - i));
      i = stop;
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && source[j] !== ch) {
        j += source[j] === "\\" ? 2 : 1;
      }
      const stop = Math.min(j + 1, n);
      blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    out.push(ch);
    i += 1;
  }

  return out.join("").split("\n");
}

function tsxFiles(dir = "src"): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (path.endsWith(".tsx")) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** 幂运算（`1024 ** 3`）不是 Markdown，排除掉。 */
function isExponent(line: string): boolean {
  return /[\w)\]]\s*\*\*\s*[\w(]/.test(line) && !/[\u4e00-\u9fff]\s*\*\*/.test(line);
}

test("JSX 文本里没有会被原样渲染的 `**`", () => {
  const offenders: string[] = [];

  for (const file of tsxFiles()) {
    const raw = readFileSync(file, "utf8");
    const cleaned = stripComments(raw);
    const rawLines = raw.split("\n");

    cleaned.forEach((line, index) => {
      if (!/\*\*[^*\n]+\*\*/.test(line)) return;
      if (isExponent(line)) return;
      offenders.push(`${file}:${index + 1}  ${rawLines[index]?.trim().slice(0, 80)}`);
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `这些位置的 \`**\` 会原样显示给用户，请改用 <strong>：\n  ${offenders.join("\n  ")}`,
  );
});

test("注释里的 `**` 不被误报（这个检查器本身要可靠）", () => {
  // 第一版检测器没剥离注释，报出 115 处**全是误报** —— 一个不可靠的检查
  // 比没有检查更糟：它会让人习惯性忽略。这里用一个样本确认剥离生效。
  const sample = `
/**
 * 注释里的 **强调** 是合法的，不该被报出来。
 * 幂运算 1024 ** 3 也不是 Markdown。
 */
export function f() {
  // 行注释里的 **也合法**
  const x = 1024 ** 3;
  return <p>文本里的 **这个** 才是问题</p>;
}`;
  const cleaned = stripComments(sample);
  const hits = cleaned
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\*\*[^*\n]+\*\*/.test(line) && !isExponent(line));

  assert.equal(hits.length, 1, `应只命中文本节点那一处，实际 ${hits.length} 处`);
  assert.match(hits[0]!.line, /这个/);
});

test("扫描确实覆盖到源码（不是扫了空集）", () => {
  const files = tsxFiles();
  assert.ok(files.length > 20, `只扫到 ${files.length} 个 tsx 文件`);
  assert.ok(files.some((f) => f.includes("settings-client")), "没扫到已知有文案的文件");
});
