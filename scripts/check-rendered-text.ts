/**
 * 渲染结果检查：抓各页面的 HTML，找出会**原样显示给用户**的 Markdown 标记，
 * 以及**没检查到的页面**。
 *
 * 用法：
 *   npm run check:rendered [base-url]
 *   HITANI_SESSION_COOKIE='hitani_session=…' npm run check:rendered
 *
 * ## 为什么需要它（源码正则不够）
 *
 * `tests/jsx-text.test.ts` 在 `.tsx` 里找 JSX 文本位置的 `**`。那个检测器
 * **改到第三版仍在误报** —— 注释、模板字符串、幂运算都会干扰
 * （第一版报出 115 处「命中」，全是误报）。
 *
 * 这个方法绕开语法歧义：直接看**服务端渲染出的 HTML**，即用户真正看到的东西。
 * 两者互补：
 *
 *   源码正则：不看运行状态，但没有死角（能覆盖任何分支的代码）
 *   HTML 抓取：看真实结果，但**只看得到当前分支**
 *
 * ## 它抓到过一次源码检查看不见的问题
 *
 * 修完星号后源码干净、单测全绿，但**镜像是旧的** —— 页面上仍显示
 * `**不会保存**`。源码级测试永远看不到「构建产物过期」。
 *
 * ## 三种结果，不是两种
 *
 * 最初这脚本用 `curl ... || true`，把 500 / 超时 / 连接拒绝都报成「干净」——
 * **假阴性**，会让检查形同虚设（与源码检查那边 115 处误报同类的可靠性问题）。
 *
 * 现在区分：
 *
 *   干净   —— 抓到了页面，且没有 Markdown 泄漏
 *   命中   —— 抓到了页面，但有泄漏（附具体文本）
 *   未检查 —— 没抓到**预期内容**（HTTP 非 2xx、连接失败、或渲染出的
 *            不是这个页面 —— 例如被重定向到登录页）
 *
 * `未检查` 以非零退出码结束：**没检查 ≠ 通过**。
 *
 * 「预期内容」用每个路径的**特征串**判断。只用 HTTP 状态不够 ——
 * Next 在重定向时会先流式吐出 200 外壳，状态码看着正常，内容却是登录页。
 */


interface PageSpec {
  path: string;
  /** 该页面**正常渲染时**必然出现的文本。缺失即视为「未检查」。 */
  marker: string;
}

const PAGES: PageSpec[] = [
  { path: "/", marker: "探索" },
  { path: "/?keyword=%E9%AD%94%E6%B3%95", marker: "搜索结果" },
  { path: "/library", marker: "我的追番" },
  { path: "/library?view=list", marker: "我的追番" },
  { path: "/library?status=done", marker: "我的追番" },
  { path: "/timeline", marker: "时光机" },
  { path: "/timeline?scope=bgm", marker: "时光机" },
  { path: "/schedule", marker: "新番时间表" },
  { path: "/settings", marker: "账号设置" },
  { path: "/friends", marker: "好友" },
  { path: "/register", marker: "注册" },
  { path: "/subjects/493016", marker: "制作人员" },
  { path: "/persons/49339", marker: "参与作品" },
];

/**
 * 会原样显示给用户的 Markdown 标记。
 *
 * - `**粗体**`、`` `行内代码` ``、`[链接](url)`
 */
const LEAK_PATTERN = /\*\*[^*\n]{1,40}\*\*|`[^`\n]{1,40}`|\[[^\]\n]{1,30}\]\(https?:[^)\n]{1,60}\)/g;

/**
 * 剥掉 `<script>` 块与 HTML 标签，得到**纯文本**。
 *
 * 必须用 `[\s\S]*?` 而不是 `.*?` —— 后者（以及 `sed` 那种按行处理）
 * 跨不了行，会把跨行的 script 整段吃掉，连正文一起吞掉。
 * 这个坑实测踩过：标记串因此「消失」，看起来像页面没渲染。
 */
function toVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

interface Result {
  path: string;
  status: "clean" | "leaked" | "unchecked";
  detail?: string;
}

async function checkPage(base: string, page: PageSpec, cookie: string | null): Promise<Result> {
  const url = `${base}${page.path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
  } catch (error) {
    return {
      path: page.path,
      status: "unchecked",
      detail: `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  /*
   * 3xx 也视为「未检查」而不是失败：需要登录的页面会重定向到 /login。
   * 那不是页面坏了，而是**这次检查没覆盖到它** —— 必须如实报告。
   */
  if (response.status < 200 || response.status >= 300) {
    return { path: page.path, status: "unchecked", detail: `HTTP ${response.status}` };
  }

  const html = await response.text();
  const text = toVisibleText(html);

  if (!text.includes(page.marker)) {
    return {
      path: page.path,
      status: "unchecked",
      detail: `渲染结果里没有「${page.marker}」——很可能被重定向到登录页`,
    };
  }

  const leaks = [...new Set(text.match(LEAK_PATTERN) ?? [])];
  if (leaks.length > 0) {
    return { path: page.path, status: "leaked", detail: leaks.join(" ") };
  }
  return { path: page.path, status: "clean" };
}

/**
 * 检查器自检。
 *
 * 一个不可靠的检查比没有检查更糟 —— 它让人习惯性忽略。这里用合成的 HTML
 * 验证三件事：能抓到泄漏、能正确剥 script、能把「内容不对」判为未检查。
 */
function selfTest(): string[] {
  const problems: string[] = [];

  const leaking = "<p>密码仅用于换取访问令牌，**不会保存**</p>";
  if ((toVisibleText(leaking).match(LEAK_PATTERN) ?? []).length === 0) {
    problems.push("没能抓到文本里的 **粗体**");
  }

  const withBacktick = "<p>用 `npm install` 安装</p>";
  if ((toVisibleText(withBacktick).match(LEAK_PATTERN) ?? []).length === 0) {
    problems.push("没能抓到文本里的 `行内代码`");
  }

  // 跨行 script 必须被完整剥掉，且不能吞掉正文
  const multiline = `
    <script>
      self.__next_f.push([1, "**这不该被抓到**"]);
    </script>
    <p>正文：我的追番</p>`;
  const strippedText = toVisibleText(multiline);
  if (strippedText.includes("这不该被抓到")) {
    problems.push("跨行 <script> 没剥干净（RSC 载荷会被误当成正文）");
  }
  if (!strippedText.includes("我的追番")) {
    problems.push("剥 script 时把正文也吞掉了");
  }

  // 正常文本不该被误报（正则过宽会是这类问题）
  const clean = "<p>密码不会保存，只用一次</p>";
  if ((toVisibleText(clean).match(LEAK_PATTERN) ?? []).length > 0) {
    problems.push("对正常文本产生了误报");
  }

  return problems;
}

async function main(): Promise<void> {
  const base = process.argv[2] ?? "http://127.0.0.1:3100";
  // 会话从**环境变量**读，不走命令行参数 —— 参数会进 shell history 与 `ps`，
  // 而它等同于登录凭据。
  const cookie = process.env.HITANI_SESSION_COOKIE?.trim() || null;

  console.log(`渲染结果检查：${base}`);
  if (!cookie) {
    console.log("（未提供 HITANI_SESSION_COOKIE —— 需要登录的页面会被报成「未检查」，那是正确行为）");
  }

  const selfProblems = selfTest();
  if (selfProblems.length > 0) {
    console.log("\n✗ 检查器自检失败，结果不可信：");
    for (const p of selfProblems) console.log(`   · ${p}`);
    process.exitCode = 2;
    return;
  }
  console.log("检查器自检通过\n");

  const results: Result[] = [];
  for (const page of PAGES) {
    results.push(await checkPage(base, page, cookie));
  }

  for (const r of results) {
    if (r.status === "clean") console.log(`  ${r.path.padEnd(30)} 干净`);
    else if (r.status === "leaked") console.log(`  ${r.path.padEnd(30)} ✗ ${r.detail}`);
    else console.log(`  ${r.path.padEnd(30)} ⚠ 未检查（${r.detail}）`);
  }

  const clean = results.filter((r) => r.status === "clean").length;
  const leaked = results.filter((r) => r.status === "leaked");
  const unchecked = results.filter((r) => r.status === "unchecked");

  console.log(`\n干净 ${clean} · 命中 ${leaked.length} · 未检查 ${unchecked.length}`);

  if (leaked.length > 0) {
    console.log("\n✗ 以下页面会把 Markdown 标记原样显示给用户：");
    for (const r of leaked) console.log(`   ${r.path}  ${r.detail}`);
  }
  if (unchecked.length > 0) {
    console.log("\n⚠ 有页面**没有被检查到** —— 这不等于通过。");
    console.log("   需要登录的页面请带上会话：");
    console.log("     HITANI_SESSION_COOKIE='hitani_session=…' npm run check:rendered");
  }

  // 命中或未检查都以非零退出 —— 不让「没检查」被当成「没问题」。
  if (leaked.length > 0 || unchecked.length > 0) process.exitCode = 1;
}

// 供自检复用；直接执行时才跑主流程。
export { LEAK_PATTERN, toVisibleText };

void main();
