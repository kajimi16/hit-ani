/**
 * Markdown 结构守卫。
 *
 * ## 为什么值得单独守
 *
 * 这个仓库里改文档时，我用行号定位做过两次**同类**错误：
 *
 * 1. 把 `## 3. 反向代理（**必需**）` 插进了上一节的 ```nginx 代码块**中间**，
 *    顺带覆盖掉 `location / {` 的闭合花括号；
 * 2. 清理时又把 `### 先说弹幕 WebSocket` 标题删掉。
 *
 * 两次都是「行号锚点过期 + 没有立刻复核」，而后果是**文档静默坏掉**：
 * 标题变成代码、代码块不再配平 —— 渲染出来一片混乱，但**没有任何东西会报错**。
 * 纯 Markdown 没有编译器，所以这类错误只能靠显式检查。
 *
 * ## 检查什么
 *
 * 1. **代码围栏配平** —— ``` 开合必须成对，否则后面整段文档都被吞进代码块；
 * 2. **围栏内不得出现 Markdown 标题** —— 这是错误 1 的直接特征。
 *    注意：`#` 开头的**注释**在 bash 代码块里是合法的，所以判据是
 *    「以 `#` 开头且**后面跟空格再接非空内容**，并且该行看起来像标题」——
 *    这里用更严的口径：`^#{1,6} ` 且**不含**常见的注释标记形式。
 *    为了不做过度聪明的猜测，只报「`## ` 及以上、且不含 shell 注释特征」的行。
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * 仓库里所有对外的 Markdown。
 *
 * 用 `readdirSync` 手走一层，而不是 `fs.globSync` —— 后者是较新的 API，
 * 本仓库的 `@types/node` 还没有它（`tsc` 会报 «has no exported member»）。
 * 与 `tests/null-ordering.test.ts` 的写法保持一致。
 */
function markdownFiles(): string[] {
  const out: string[] = [];
  const roots = [".", "docs", "deploy"];
  for (const dir of roots) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      if (entry.name.startsWith(".")) continue;
      out.push(dir === "." ? entry.name : join(dir, entry.name));
    }
  }
  return out.sort();
}

interface Problem {
  file: string;
  line: number;
  detail: string;
}

/**
 * 是否像「代码块内的 shell 注释」而不是 Markdown 标题。
 *
 * `# 安装依赖` 在 bash 里是注释；`# 安装依赖` 在 Markdown 里也可能是标题 ——
 * 两者无法从单行区分。因此只在**能确定是标题**时报错：围栏内的 `## ` 及以上
 * （二级标题在 shell 脚本里几乎不可能作为注释出现，而一级 `#` 很常见）。
 */
function looksLikeShellComment(line: string): boolean {
  return /^#{1}\s/.test(line);
}

function scan(file: string): Problem[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const problems: Problem[] = [];
  let insideFence = false;
  let fenceStart = 0;
  let fenceMarker = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);

    if (fence) {
      const marker = fence[1][0];
      if (!insideFence) {
        insideFence = true;
        fenceStart = i + 1;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        insideFence = false;
      }
      continue;
    }

    // 围栏内的 Markdown 标题：错误 1 的直接特征
    if (insideFence && /^#{2,6}\s+\S/.test(line) && !looksLikeShellComment(line)) {
      problems.push({
        file,
        line: i + 1,
        detail: `代码块内出现 Markdown 标题（与第 ${fenceStart} 行的围栏不匹配）：${line.slice(0, 60)}`,
      });
    }
  }

  if (insideFence) {
    problems.push({
      file,
      line: fenceStart,
      detail: `代码围栏未闭合（自第 ${fenceStart} 行的 \`${fenceMarker}\` 起）`,
    });
  }
  return problems;
}

test("Markdown 代码围栏配平，且围栏内没有标题", () => {
  const files = markdownFiles();
  const problems = files.flatMap(scan);
  assert.deepEqual(
    problems,
    [],
    `Markdown 结构问题：\n  ${problems.map((p) => `${p.file}:${p.line}  ${p.detail}`).join("\n  ")}`,
  );
});

test("扫描确实覆盖到文档（不是扫了空集）", () => {
  const files = markdownFiles();
  assert.ok(files.length >= 3, `只扫到 ${files.length} 个 Markdown，检查 glob 是否失效`);
  // 这几个是本项目的核心文档，必须被覆盖
  for (const required of ["README.md", "docs/DEPLOY.md", "docs/ANIMEKO-UI.md"]) {
    assert.ok(files.includes(required), `未覆盖 ${required}`);
  }
});

test("检查本身有效 —— 故意构造的坏文档必须被报出来", () => {
  // 用一个临时文件验证判据，避免「检查永远通过」这种坏法
  const probe = "docs/.fence-probe.md";
  const bad = ["# 标题", "", "```nginx", "server {", "## 混进代码块的标题", "}", "```", ""].join("\n");
  const good = ["# 标题", "", "```bash", "# 这是 shell 注释，合法", "echo hi", "```", ""].join("\n");
  try {
    writeFileSync(probe, bad, "utf8");
    assert.ok(scan(probe).length >= 1, "围栏内的 `## ` 标题必须被报出来");

    writeFileSync(probe, good, "utf8");
    assert.deepEqual(scan(probe), [], "bash 注释不该被误报");

    writeFileSync(probe, "```bash\necho hi\n", "utf8");
    assert.ok(scan(probe).length >= 1, "未闭合围栏必须被报出来");
  } finally {
    rmSync(probe, { force: true });
  }
});
