# 当前部署状态（供体验）

> 生成时间：2026-10-05
> 部署位置：本机 Docker Compose

---

## 访问方式

```
http://192.168.6.203:3100
```

**账号**：`alice@hit.edu.cn` · **密码**见项目根 `.alice-credentials`（600，已 gitignore）

> ⚠️ 地址是**当前局域网 IP**。之前记的 `10.249.61.10` 是校园网地址 —— 换网络后
> 旧地址自然失效。查当前地址：`ip -4 -o addr show | grep -v 127.0.0.1`

---

## 服务状态

| 服务 | 端口 | 状态 | 说明 |
| --- | --- | --- | --- |
| **web** | 3100 | ✅ healthy | 页面 + API，唯一对外入口 |
| **gateway** | 3102 | ✅ healthy | 弹幕 WebSocket |
| **proxy** | — | ✅ | 代理转发（见下） |
| **postgres** | 127.0.0.1:55433 | ✅ healthy | 仅本机可达 |
| jellyfin | 3103 | ⏸ 已停 | **见「不可用功能」** |

冒烟 58/58 · 单测 332/332。数据完整：**收藏 376 · 有短评 233 · 进度 5943 · 条目 397**。

**一条命令重启全部**（无需任何手动前置）：

```bash
cd /home/kajimi/interesting_project/hit-ani
docker compose up -d
```

---

## ⚠️ 不可用的功能：Jellyfin 媒体库

**原因**：**外挂硬盘已拔出**。

```
/dev/sda                          → 不存在
/media/kajimi/.../media/.library-root → 缺失
```

这是**哨兵机制按设计工作**的结果 —— 硬盘不在时 Jellyfin 因哨兵文件缺失而报
`unhealthy`，把「静默的空媒体库」变成可见告警。为不让它干扰「部署是否正常」的
判断，暂时停掉了该容器。

**恢复步骤**：
```bash
# 1. 插回硬盘，确认挂载成功（这一步必须有输出）
ls /media/kajimi/kajimi/hit-ani/media/.library-root

# 2. 启动
docker compose start jellyfin
```

> **硬盘的 fstab 持久化还没做** —— 现在靠 udisks2 在**登录时**自动挂载，
> 所以「插着盘但没登录」时不会挂上。见 `docs/DEPLOY.md` §9.5。

---

## Bangumi 同步：分两层，别混淆

**用户开关**在设置的「同步到 Bangumi」，存 `User.mirrorToBgm`，**默认关闭**
（写上游不可撤销，会覆盖你在 Bangumi 上的对应内容，默认替用户打开等于替他
做决定）。

**运维硬闸**在 `.env`：

```
BGM_MIRROR_ENABLED=0
```

设成 `0` 时**压过用户开关** —— 无论谁开了同步都一律拒绝写 Bangumi。
当前是关着的（为跑写库测试）。

判定顺序：硬闸 → 测试账号模式 → 用户偏好。
界面会区分「你没开这个功能」（静默）与「开了但被管理员挡住」（提示），
不会再把 `BGM_MIRROR_ENABLED` 这种内部术语显示给用户。

**恢复同步**：把上面那行改成 `1`（或删掉），然后
```bash
docker compose up -d --force-recreate web gateway
```

---

## ⚠️ 待部署：邮箱验证码（需要凭据）

注册现在**强制**要求学校邮箱验证码。代码已实现并推送，但**尚未部署** ——
因为 `.env` 里没有任何邮件配置，而验证码是必填的：

> **此刻跑 `docker compose up -d web` 会让注册整体不可用。**

（新镜像已经构建好放在本地，`latest` 指向它。这是有意的：若把标签回退到旧镜像，
`up -d` 会**静默**跑回旧代码、验证码消失，而响亮失败比静默失败好。）

### 部署前先自检

```bash
npm run check:credentials -- --send 你的邮箱 --bgm
```

它会真正连一次 SMTP、并用假 code 打 BGM 的 token 端点来区分
「凭据无效」与「授权码无效」（BGM 恰好分开报这两种错）。

### 需要填的凭据

```bash
# 邮件（必需）—— SMTP 或 HTTP API 二选一
SMTP_HOST=""  SMTP_PORT="587"  SMTP_USER=""  SMTP_PASS=""  EMAIL_FROM=""
# 或 EMAIL_API_URL=""  EMAIL_API_KEY=""

# Bangumi OAuth（可选，没有仍可用「个人访问令牌」）
BGM_CLIENT_ID=""  BGM_CLIENT_SECRET=""
# ⚠️ 必须写死并与 bgm.tv 应用里登记的值**逐字符一致**（含端口）：
BGM_REDIRECT_URI="http://192.168.6.203:3100/api/auth/bgm/callback"
```

配好后 `docker compose up -d --build web` 即可；启动日志会打印能力检查结果，
`docker compose logs web | head -20` 能直接看出注册能不能用。

---

## 代理：已做成 compose 服务（无需手动步骤）

这台机器**必须走代理**才能出网，而 Clash 只监听 `127.0.0.1:7897` ——
容器里的 `127.0.0.1` 是容器自己，到不了宿主回环。

`proxy` 服务解决了它（`alpine/socat`，host 网络，自动发现全部 docker
桥接地址并转发到宿主回环）。**只绑 `172.x.0.1`** —— 那些只有容器可达，
绑 `0.0.0.0` 会把代理暴露到局域网。

### 一个极易踩的坑：Node 的 fetch 不读 HTTP_PROXY

`undici` **不会**自动使用代理环境变量，只有 `curl` 会。症状极具误导性：

```
容器内 curl https://api.bgm.tv/...  → 200
同一个容器里应用请求                 → fetch failed
```

因此 web / gateway 除了 `HTTP_PROXY` 外，**必须有**：

```yaml
NODE_USE_ENV_PROXY: "1"
```

（Node 22.23.2 实测支持。）

### 环境可直连外网时

删掉 compose 里的 `proxy` 服务，以及 web/gateway 的
`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `NODE_USE_ENV_PROXY`，
并把各 `build.network: host` 改回默认。

> `build.network: host` 是必要的：构建期的 `npm ci` 与 `prisma generate`
> 也要出网，而构建容器同样到不了宿主回环。配合 `--build-arg` 传代理即可。

---

## 体验建议路径

1. **找番** — 首页有近期热门；搜「星际牛仔」或点快捷标签
2. **条目详情** — 章节 + 弹幕 + 评论三块同页（信息密度最高的一页）
3. **只看本校** — 勾选后校外内容被过滤（种子里 alice 本校、bob 外校）
4. **外部资源** — 按集分组，标注「可在线看」与「需下载」
5. **我的追番** — 376 部，按想看/在看/看过/搁置/抛弃分组
6. **新番时间表** — 按周聚合

**重点帮我看**（我只能验计算样式，看不到观感）：
- 条目页排版是否舒服
- 手机上是否可用（响应式只验了 CSS 值）
- 弹幕播放时的实际观感

---

## 运维命令

```bash
cd /home/kajimi/interesting_project/hit-ani

docker compose ps                    # 状态
docker compose logs -f web           # 日志
docker compose restart web           # 重启单个服务
docker compose up -d --force-recreate web gateway   # 改 .env 后重建

docker compose stop jellyfin         # 硬盘不在时
docker compose start jellyfin        # 硬盘挂回后

npm run smoke                        # 端到端验证（自动清理测试数据）
npm test                             # 单测
npm run gateway:build                # 仅调试时用；正常部署不需要
```

> `gateway` 的产物已烘进镜像，**不需要**先跑 `gateway:build` 再 `docker compose up`。
