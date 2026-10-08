#!/usr/bin/env bash
#
# 把「本项目依赖的服务」装成开机自启。**幂等**，可以反复跑。
#
#   sudo bash deploy/install-autostart.sh
#
# 为什么需要 root：Clash 核心开了 TUN（auto-route + dns-hijack），
# 建 TUN 设备与改路由表需要 CAP_NET_ADMIN。Docker 那部分不需要 root
# （docker 守护进程已 enabled，容器也已带 `restart: unless-stopped`），
# 脚本只做**核对**。
#
# 这个脚本只碰两样东西：
#   1. /etc/systemd/system/verge-mihomo.service（安装 + 启用）
#   2. 发起者桌面会话里的 ~/.config/autostart/clash-verge.desktop
#      （重命名为 .disabled —— 否则登录后 GUI 会再拉一个核心抢 7897 端口）
#
# 它**不会**碰 docker-compose.yml、不会碰数据库、不会碰媒体盘。

set -euo pipefail

readonly UNIT_NAME="verge-mihomo.service"
readonly UNIT_DST="/etc/systemd/system/${UNIT_NAME}"
readonly GUI_AUTOSTART=".config/autostart/clash-verge.desktop"
readonly PROXY_PORT=7897
readonly PROBE_URL="https://api.bgm.tv/v0/subjects/493016"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly UNIT_SRC="${SCRIPT_DIR}/${UNIT_NAME}"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

#
# 从单元的 `ExecStart=` 里取某个参数的值。
#
# 单独写成函数是因为**同一个解析要用在三处**（找发起者用户、取配置目录、
# 取配置文件）—— 三份手抄的 sed 迟早有一份写错，而写错的后果是脚本以
# 「配置目录不存在」这种与真实原因无关的信息死掉。
#
# ⚠️ 依赖 ExecStart 是**单行**。单元里说明了为什么不用反斜杠续行：
# 续行会让按行解析的脚本读到半个命令，而反斜杠的转义在 sed 里极易写错
# （实际踩过：写成 `\\\\` 时静默返回空串）。
#
exec_start_flag() {
  awk -v flag="$1" '/^ExecStart=/{for (i = 1; i <= NF; i++) if ($i == flag) print $(i + 1)}' "$UNIT_SRC"
}

# ---------------------------------------------------------------- 前置检查

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash $0"
[ -f "$UNIT_SRC" ] || die "找不到单元文件 $UNIT_SRC（请在仓库里运行）"

CORE_BIN="$(awk '/^ExecStart=/{print $1}' "$UNIT_SRC" | cut -d= -f2)"
CONF_DIR="$(exec_start_flag -d)"
CONF_FILE="$(exec_start_flag -f)"

say "核心二进制: ${CORE_BIN:-<未解析出>}"
say "配置目录:   ${CONF_DIR:-<未解析出>}"
say "配置文件:   ${CONF_FILE:-<未解析出>}"

[ -n "$CORE_BIN" ] && [ -x "$CORE_BIN" ] || die "核心二进制不可执行：${CORE_BIN:-空}"
[ -n "$CONF_DIR" ] && [ -d "$CONF_DIR" ] || die "配置目录不存在：${CONF_DIR:-空}（先确认 Clash Verge 正常运行过）"
[ -n "$CONF_FILE" ] && [ -f "$CONF_FILE" ] || die "配置文件不存在：${CONF_FILE:-空}"

# 配置能解析吗？
#
# 核心自带 `-t`（test configuration and exit）。这一步**必须在启用服务之前**
# 做：配置坏了的话服务会进入「启动 → 退出 → 3 秒后重启」的循环，
# 而 systemd 只会说「unit is activating/failed」，与「配置某一行写错」
# 毫无关系 —— 而这个脚本正要把「改配置」这件事从 GUI 手里拿走，
# 所以配置出错的可能性反而变高了。
echo
say "前置：用核心自带的 -t 校验配置"
if timeout 30 "$CORE_BIN" -d "$CONF_DIR" -f "$CONF_FILE" -t >/dev/null 2>&1; then
  ok "配置可被解析"
else
  warn "配置校验没通过 —— 先修好再跑本脚本，否则服务会崩溃重启循环"
  say "  手动看详情："
  say "    $CORE_BIN -d $CONF_DIR -f $CONF_FILE -t"
  die "配置校验失败"
fi

# ---------------------------------------------------------------- 找发起者
#
# 桌面 autostart 属于**发起 sudo 的那个用户**，不是 root。
# 优先用 SUDO_USER；直接以 root 跑时退回「配置目录的属主」。
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  TARGET_USER="$SUDO_USER"
else
  TARGET_USER="$(stat -c '%U' "$CONF_DIR" 2>/dev/null || echo root)"
fi
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
say "发起者用户: ${TARGET_USER}（${TARGET_HOME:-无 home}）"

# ---------------------------------------------------------------- ① 单元

echo
say "① 安装 systemd 单元"
install -m 644 -o root -g root "$UNIT_SRC" "$UNIT_DST"
systemctl daemon-reload
ok "已写入 ${UNIT_DST}"

# ---------------------------------------------------------------- ② GUI 自启

echo
say "② 关掉 GUI 的桌面自启（否则登录后它会再拉一个核心抢 ${PROXY_PORT} 端口）"
gui_as="${TARGET_HOME}/${GUI_AUTOSTART}"
if [ -e "$gui_as" ]; then
  mv -f "$gui_as" "${gui_as}.disabled"
  chown "${TARGET_USER}:${TARGET_USER}" "${gui_as}.disabled" 2>/dev/null || true
  ok "已重命名 → ${GUI_AUTOSTART}.disabled"
elif [ -e "${gui_as}.disabled" ]; then
  ok "已经是 .disabled（之前跑过）"
else
  warn "没有这个文件，跳过（${TARGET_USER} 可能从没开过 GUI 自启）"
fi

# ---------------------------------------------------------------- ③ 腾端口

echo
say "③ 停掉 GUI 与其拉起的核心（端口必须先空出来）"
# 用 -x 精确匹配进程名：`clash-verge` 是 GUI，`clash-verge-service` 是系统
# 助手服务（留着不动 —— 它是手动开 GUI 时用的，不影响我们）。
if pkill -x clash-verge 2>/dev/null; then ok "已退出 GUI"; else say "GUI 未在运行"; fi
if pkill -x verge-mihomo 2>/dev/null; then ok "已停掉旧核心"; else say "旧核心未在运行"; fi
sleep 2

# ---------------------------------------------------------------- ④ 启动

echo
say "④ 启用并启动服务"
systemctl enable --now "$UNIT_NAME" >/dev/null
ok "已启用（开机自启）"

echo
say "⑤ 等待 ${PROXY_PORT} 端口就绪"
for _ in $(seq 1 30); do
  ss -lnt 2>/dev/null | grep -q ":${PROXY_PORT} " && break
  sleep 1
done
ss -lnt 2>/dev/null | grep -q ":${PROXY_PORT} " \
  && ok "端口 ${PROXY_PORT} 已监听" \
  || die "端口 ${PROXY_PORT} 没起来 —— 看 journalctl -u ${UNIT_NAME} -n 50"

# ---------------------------------------------------------------- ⑥ 验证

echo
say "⑥ 端到端：经代理取一次上游（bgm.tv 正是容器最依赖的那个）"
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -x "http://127.0.0.1:${PROXY_PORT}" "$PROBE_URL")" = "200" ]; then
  ok "经代理访问 bgm.tv → 200"
else
  warn "经代理访问 bgm.tv 失败 —— 代理进程起来了但出口可能不对"
fi

echo
say "⑦ 核对 Docker 侧（这一侧不需要 root，脚本只读不改）"
if systemctl is-enabled docker >/dev/null 2>&1; then
  ok "docker 守护进程：开机自启已启用"
else
  warn "docker 未启用开机自启 → sudo systemctl enable docker"
fi

cat <<EOF

  完成。现在这个项目的依赖链在重启后会自动起来：

    docker.service            → 已 enabled（容器带 restart: unless-stopped，
                                 守护进程起来后自动把它们拉回来）
      ├─ hit-ani-postgres-1   → 数据库
      ├─ hit-ani-proxy-1      → socat 把宿主的 ${PROXY_PORT} 转给容器
      ├─ hit-ani-web-1        → 站点
      └─ hit-ani-gateway-1    → 弹幕 WebSocket
    ${UNIT_NAME}      → 本次新装的代理核心（容器出网依赖它）

  ⚠️ 两个要记住的行为：

  1. **改节点/订阅后要重启核心**才生效（GUI 不再代管了）：
         sudo systemctl restart ${UNIT_NAME}
     想临时用 GUI 切节点的话，先停服务，否则两个核心会抢 ${PROXY_PORT}：
         sudo systemctl stop ${UNIT_NAME}     # 用完再 start

  2. **Jellyfin 与 418G 媒体盘按你的选择没有纳入自启**（外挂盘现在没插）。
     它现在是停止状态，重启后仍是停止状态。

  常用排查：
     systemctl status ${UNIT_NAME}
     journalctl -u ${UNIT_NAME} -n 50 --no-pager
     curl -x http://127.0.0.1:${PROXY_PORT} -sI ${PROBE_URL}
EOF
