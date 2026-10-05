# 当前部署状态（供体验）

> 生成时间：2026-10-05
> 部署位置：本机 Docker Compose（非生产服务器）

---

## 访问方式

```
http://192.168.6.203:3100
```

**账号**：`alice@hit.edu.cn`
**密码**：见项目根目录的 `.alice-credentials`（600 权限，已 gitignore）

> ⚠️ 地址是**当前局域网 IP**。之前记录的 `10.249.61.10` 是校园网的地址，
> 现在已经换到 `192.168.6.x` 这个网络 —— 换网络后旧地址自然失效。
> 查当前地址：`ip -4 -o addr show | grep -v 127.0.0.1`

---

## 服务状态

| 服务 | 端口 | 状态 | 说明 |
| --- | --- | --- | --- |
| **web** | 3100 | ✅ healthy | 页面 + API，唯一对外的入口 |
| **gateway** | 3102 | ✅ healthy | 弹幕 WebSocket |
| **postgres** | 127.0.0.1:55433 | ✅ healthy | 仅本机可达 |
| jellyfin | 3103 | ⏸ 已停 | **见下方说明** |

冒烟 58/58、单测 332/332 全绿。数据完整：

```
收藏 376 · 有短评 233 · 单集进度 5943 · 缓存条目 397
```

---

## ⚠️ 两个当前不可用的功能

### 1. 「在这里看」（Jellyfin 媒体库）—— 不可用

**原因**：**外挂硬盘已拔出**。实测确认：

```
/dev/sda            → 不存在
/media/kajimi/...   → 挂载点回到根文件系统，media/ 为空
```

这是**哨兵机制按设计工作**的结果 —— 硬盘不在时 Jellyfin 会因
`.library-root` 缺失而报 `unhealthy`，把「静默的空媒体库」变成可见告警。
为避免它持续刷告警，我暂时停掉了该容器。

**恢复方式**：
```bash
# 1. 插回硬盘，确认挂载
ls /media/kajimi/kajimi/hit-ani/media/.library-root

# 2. 启动 Jellyfin
docker compose start jellyfin
```

> 另外，硬盘的 fstab 持久化**还没做** —— 现在靠 udisks2 在登录时自动挂载，
> 所以插着盘但没登录时，它不会自动挂上。见 `docs/DEPLOY.md` §9.5。

### 2. 「媒体源」管理页 —— 403（预期行为）

`ADMIN_EMAILS` 当前为空 → **无人是管理员** → `/sources` 与
`/api/media/sources` 返回 403。

这是上一轮安全修复的**有意设计**：抓取源是全站共享配置，不该让任何人改。

**不影响**普通用户 —— 18 个抓取源仍在工作，「外部资源」面板正常：

```
subject 253（星际牛仔）     → 61 条资源，其中 25 条可在线看
subject 101437（忍者杀手）  → 39 条资源，其中 15 条可在线看
```

**想自己配置源**：在 `.env` 填 `ADMIN_EMAILS="你的邮箱"` 后
`docker compose up -d --force-recreate web gateway`。

---

## ⚠️ 当前的同步开关状态

`.env` 里有一行：

```
BGM_MIRROR_ENABLED=0
```

**这意味着：你在站内标记收藏 / 进度，不会同步到你的 Bangumi 账号。**

这是我为安全测试临时加的（此前发生过一次测试数据被写进真实 BGM 账号的事故）。
闸门能自动拦住 `smoke-*` 这类测试账号，但拦不住手工 curl。

**想恢复同步**：删掉那一行，然后
```bash
docker compose up -d --force-recreate web gateway
```

---

## 体验建议路径

1. **找番** → 首页直接有近期热门；搜「星际牛仔」或点快捷标签
2. **条目详情** → 章节 + 弹幕 + 评论影评三块都在同一页
3. **只看本校** → 勾选后校外弹幕/评论会被过滤（种子数据里 alice 是本校、bob 是外校）
4. **外部资源** → 按集分组，标注「可在线看」与「需下载」
5. **我的追番** → 376 部，按想看/在看/看过/搁置/抛弃分组
6. **新番时间表** → 按周聚合

**重点看**（我只能验计算样式，看不到观感）：
- 条目页信息密度最高，排版是否舒服
- 手机上是否可用（响应式我只验了 CSS 值）
- 弹幕播放时的实际观感

---

## 运维命令

```bash
cd /home/kajimi/interesting_project/hit-ani

docker compose ps                    # 状态
docker compose logs -f web           # 日志
docker compose restart web           # 重启单个服务
docker compose stop jellyfin         # 停（硬盘不在时）
docker compose start jellyfin        # 起（硬盘挂回后）

npm run smoke                        # 端到端验证（自动清理测试数据）
npm test                             # 单测
```

### 代理配置（本机特有）

这台机器**必须走代理**才能出网（Clash 在 `127.0.0.1:7897`），
而 Clash 只监听回环地址，容器访问不到。因此：

1. `socat` 把 docker 网关的两个地址转发到宿主机代理：
   ```bash
   for ip in 172.17.0.1 172.21.0.1; do
     nohup socat TCP-LISTEN:7897,bind=$ip,fork,reuseaddr TCP:127.0.0.1:7897 &
   done
   ```
   > 这是**临时进程**，重启后需要重新执行。
2. compose 里给 web/gateway 配了 `HTTP_PROXY` / `HTTPS_PROXY`，
   **以及关键的 `NODE_USE_ENV_PROXY=1`** —— Node 的 `fetch` 默认不读代理
   环境变量（只有 curl 读），没有它所有外部请求都会 `fetch failed`。

校内服务器若能直连外网，删掉这几行环境变量即可。
