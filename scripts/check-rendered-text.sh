#!/usr/bin/env bash
#
# 渲染结果交叉验证：抓取各页面的 HTML，找出会**原样显示给用户**的 Markdown 标记。
#
# ## 为什么需要它（而不是只靠正则扫源码）
#
# `tests/jsx-text.test.ts` 用正则在 `.tsx` 里找 JSX 文本位置的 `**`。那个
# 检测器**改到第三版仍在误报** —— 注释、模板字符串、幂运算都会干扰
# （第一版报出 115 处「命中」，全是误报）。
#
# 这个方法绕开所有语法歧义：直接看**服务端渲染出的 HTML**，
# 也就是用户真正看到的东西。两者互补：
#
#   源码正则：不看运行状态，但没有死角（能覆盖任何分支的代码）
#   HTML 抓取：看真实结果，但**只看得到当前分支**（条件/tab 里的文案看不到）
#
# ## 它抓到过一次源码检查看不见的问题
#
# 修完星号后源码是干净的、单测全绿，但**镜像是旧的** —— 页面上仍然显示
# `**不会保存**`。是这条检查发现的：源码级测试永远看不到「构建产物过期」。
#
# 用法：
#   scripts/check-rendered-text.sh [base-url] [cookie]
#
# 默认打 `http://127.0.0.1:3100`，不带会话（公开页面）。带上会话可以看到
# 登录后才渲染的区块（设置页的 Jellyfin / 收藏导入说明就在那里）。

set -uo pipefail

BASE="${1:-http://127.0.0.1:3100}"
COOKIE="${2:-}"

# 要检查的路径。带上会渲染出不同分支的查询参数。
PATHS=(
  "/"
  "/?keyword=%E9%AD%94%E6%B3%95"
  "/library"
  "/library?view=list"
  "/library?status=done"
  "/timeline"
  "/timeline?scope=bgm"
  "/schedule"
  "/settings"
  "/friends"
  "/login"
  "/register"
  "/subjects/493016"
  "/persons/49339"
  "/users/nonexistent-page"
)

# 要找的：会原样显示的 Markdown 标记。
# - `**粗体**`
# - `` `行内代码` ``（同理，HTML 里会原样显示反引号）
# - `[链接](url)` 这种语法残留在正文里
PATTERN='\*\*[^*]{1,40}\*\*|`[^`]{1,40}`|\[[^]]{1,30}\]\(http[^)]{1,60}\)'

total=0
printf '渲染结果检查：%s\n\n' "$BASE"

for path in "${PATHS[@]}"; do
  if [ -n "$COOKIE" ]; then
    html=$(curl -s -m 20 -H "Cookie: $COOKIE" "$BASE$path" || true)
  else
    html=$(curl -s -m 20 "$BASE$path" || true)
  fi

  # 只统计正文，排除 <script> 里的 RSC 载荷 —— 那里的字符串不是渲染结果。
  # （RSC 载荷会把同一段文案再传一遍，导致重复计数。）
  body=$(printf '%s' "$html" | sed 's|<script[^>]*>.*</script>||g' | tr -d '\n')
  hits=$(printf '%s' "$body" | grep -oE "$PATTERN" | sort -u | tr '\n' ' ')

  if [ -z "$hits" ]; then
    printf '  %-30s 干净\n' "$path"
  else
    printf '  %-30s ✗ %s\n' "$path" "$hits"
    total=$((total + 1))
  fi
done

printf '\n有问题的页面：%d\n' "$total"
[ "$total" -eq 0 ] || exit 1
