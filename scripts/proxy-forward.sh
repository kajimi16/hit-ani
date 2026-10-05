#!/bin/sh
# 代理转发器：把 docker 桥接地址上的连接转发到宿主机的回环代理。
#
# ## 为什么需要它
#
# 本机的 Clash 只监听 `127.0.0.1:7897`，而容器里的 `127.0.0.1` 是容器自己，
# 且 Clash 不监听任何容器可达的地址 —— 因此容器里的应用**无法出网**，
# 表现为所有外部请求 `fetch failed`（BGM 搜索、Animeko、dandanplay 全挂）。
#
# 这个脚本在**宿主机网络命名空间**里监听 docker 桥接网关地址，
# 转发到宿主回环上的代理。容器经默认网关即可访问。
#
# ## 为什么只绑 172.x.0.1
#
# 那些是 docker 桥接网关，只有容器可达。绑 `0.0.0.0` 会把代理暴露到
# 局域网（等于开一个开放代理），不能用。
#
# ## 若你的环境可直连外网
#
# 删掉 compose 里的 `proxy` 服务，以及 web/gateway 的
# `HTTP_PROXY` / `HTTPS_PROXY` / `NODE_USE_ENV_PROXY` 即可。

set -eu

UPSTREAM="${UPSTREAM:-127.0.0.1:7897}"
LISTEN_PORT="${LISTEN_PORT:-7897}"

# 收集 docker 桥接接口的 IPv4 地址。BusyBox 的 ip/awk 足够，无需 grep -P。
ips=$(ip -4 -o addr show | awk '
  $2 ~ /^(docker0|br-)/ {
    split($4, parts, "/")
    print parts[1]
  }
')

if [ -z "$ips" ]; then
  echo "[proxy] 未找到 docker 桥接地址 —— 容器将无法访问代理" >&2
  exit 1
fi

pids=""
for ip in $ips; do
  socat "TCP-LISTEN:${LISTEN_PORT},bind=${ip},fork,reuseaddr" "TCP:${UPSTREAM}" &
  pid=$!
  pids="$pids $pid"
  echo "[proxy] ${ip}:${LISTEN_PORT} -> ${UPSTREAM} (pid ${pid})"
done

# 任一子进程退出或收到终止信号时，清理其余 socat 并退出。
trap 'kill $pids 2>/dev/null || true; exit 0' TERM INT

echo "[proxy] 就绪，监听 ${LISTEN_PORT} 端口"
wait
