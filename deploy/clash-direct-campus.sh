#!/usr/bin/env bash
#
# 让本机自己托管的站点**不走代理**（Clash 里加一条 DIRECT 规则）。**幂等**。
#
#   sudo bash deploy/clash-direct-campus.sh
#
# ## 为什么需要它
#
# 本机托管的站点（`ani.kajimi.cc`）解析到**校园私网地址**（10.249.61.10）。
# Clash 的规则表末尾是 `MATCH,节点选择` 兜底，于是这个域名会被发给**境外节点** ——
# 那个节点当然连不到校园私网，浏览器表现为「未发送任何数据」/ Empty reply。
#
# 实测（加规则前）：
#   [TCP] ... --> ani.kajimi.cc:80 match Match using 节点选择[香港HKT-A]
# 加规则后：
#   [TCP] ... --> ani.kajimi.cc:80 match DomainSuffix(kajimi.cc) using DIRECT
#
# 用 `DOMAIN-SUFFIX,kajimi.cc` 而不是逐个域名：同一后缀下可能还有别的自建站点
# （本机就有 gal），而且将来加子域名也不用再改。
#
# ## ⚠️ 为什么要有这个脚本
#
# `clash-verge.yaml` 是 Clash Verge **生成的运行期配置**。若你打开 Clash Verge
# GUI 并让它重新生成配置，手工加的这条规则**可能被冲掉** —— 症状是「浏览器
# 又打不开自己的站点了」。重跑本脚本即可恢复。
#
# 规则插在规则表**最前**：具体规则必须在 `MATCH` 兜底之前。

set -euo pipefail

readonly RULE="DOMAIN-SUFFIX,kajimi.cc,DIRECT"
readonly UNIT="verge-mihomo.service"

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "需要 root：sudo bash $0"

# 配置路径取自 systemd 单元，不在这里重抄一遍 —— 两处各写一次迟早不一致
CONF="$(awk '/^ExecStart=/{for (i = 1; i <= NF; i++) if ($i == "-f") print $(i + 1)}' \
        "/etc/systemd/system/${UNIT}" 2>/dev/null || true)"
[ -n "$CONF" ] || CONF="/home/kajimi/.local/share/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml"
[ -f "$CONF" ] || die "找不到 Clash 配置：$CONF"
say "配置: $CONF"

if grep -qF -- "- ${RULE}" "$CONF"; then
  ok "规则已存在，无需改动"
else
  cp "$CONF" "${CONF}.bak.$(date +%s)"
  say "已备份原配置（同目录下的 .bak.*）"
  RULE="$RULE" python3 - "$CONF" <<'PY'
import os, sys, pathlib
path = pathlib.Path(sys.argv[1])
rule = os.environ["RULE"]
lines = path.read_text(encoding="utf-8").split("\n")
try:
    i = lines.index("rules:")
except ValueError:
    sys.exit("配置里没有 `rules:` 段")
lines[i + 1 : i + 1] = [
    f"- {rule}",
    "  # 本机自建站点解析到校园私网地址，不能走境外节点（见 deploy/clash-direct-campus.sh）",
]
path.write_text("\n".join(lines), encoding="utf-8")
print("  已插入规则")
PY
  ok "已插入 - ${RULE}"
fi

echo
say "校验配置（核心自带 -t）"
CORE="$(awk '/^ExecStart=/{print $1}' "/etc/systemd/system/${UNIT}" | cut -d= -f2)"
DIR_CFG="$(dirname "$CONF")"
if timeout 30 "$CORE" -d "$DIR_CFG" -f "$CONF" -t >/dev/null 2>&1; then
  ok "配置可被解析"
else
  die "配置校验失败，已保留 .bak 备份 —— 请手工检查"
fi

echo
say "重启核心让规则生效"
systemctl restart "$UNIT"
sleep 5
systemctl is-active --quiet "$UNIT" && ok "$UNIT 已重启" || die "$UNIT 未起来"

echo
say "端到端：本机走域名"
CODE="$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 15 http://ani.kajimi.cc/ || true)"
if [ "$CODE" = "301" ] || [ "$CODE" = "200" ]; then
  ok "http://ani.kajimi.cc/ → ${CODE}（浏览器现在应当能访问）"
else
  printf '  \033[33m!\033[0m http://ani.kajimi.cc/ → %s\n' "${CODE:-连接失败}"
  say "  排查：journalctl -u ${UNIT} -n 30 | grep kajimi"
fi
