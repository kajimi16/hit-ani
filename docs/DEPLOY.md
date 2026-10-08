# 部署

面向**实际把服务跑起来给同学用**的场景。开发环境直接 `npm run dev` 即可，不需要本文档。

---

## 0. 选哪种方式

| 方式 | 适合 | 代价 |
| --- | --- | --- |
| **Docker Compose**（推荐） | 任何有 Docker 的机器 | 需要装 Docker |
| 裸机 + systemd | 没有 Docker 但想常驻 | 需手动管依赖与两个进程 |

**关键约束（两种方式都适用）**：服务**不能**跑在 `next dev` 上，也**不能**绑在某个交互式会话里。

- `next dev` 是按需编译的开发模式，首访慢、无压缩、单进程无自动重启
- 绑在交互式会话（SSH 登录、终端）里，会话一断服务就死

本文档的两种方式都满足这两点。

---

## 1. Docker Compose（推荐）

### 1.1 准备环境变量

```bash
cp .env.example .env
```

**必填**（缺了 compose 会直接拒绝启动，这是刻意的）：

| 变量 | 说明 |
| --- | --- |
| `POSTGRES_PASSWORD` | 数据库密码。**生产环境务必改成强密码** —— 它是数据库的唯一防线 |
| `SESSION_SECRET` | 会话签名密钥。`openssl rand -base64 48` 生成 |

**注册必填 —— 缺了不是「少个功能」，而是整个注册不可用**：

| 变量 | 不配的后果 |
| --- | --- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `EMAIL_FROM` | 注册**整体不可用**（发码接口 503） |
| 或 `EMAIL_API_URL` / `EMAIL_API_KEY` | 同上（两者配一个即可） |

注册**强制**要求学校邮箱验证码，因此这一组**必须配**。邮件传输是**可插拔**的：
配了 `SMTP_*` 就走 SMTP，否则走 `EMAIL_API_*`（后者适配 Cloudflare 后面的
MailChannels / Resend / 自建 Worker —— 期望的形状见 `.env.example`）。

**部署后立刻可见** —— 启动日志会打印能力检查：

```
⚠️  部署能力检查发现问题：
   · 未配置邮件发送（SMTP_HOST 与 EMAIL_API_URL 都为空）—— 注册功能不可用。
```

**配好后先自检**（真连一次 SMTP + 用假 code 打 BGM 的 token 端点）：

```bash
npm run check:credentials -- --send 你的邮箱 --bgm
```

**按需填**（留空则该功能不可用，不影响其它部分）：

| 变量 | 留空的影响 |
| --- | --- |
| `BGM_CLIENT_ID` / `BGM_CLIENT_SECRET` | 无法绑定 Bangumi，也就无法一键导入收藏 |
| `QQ_APP_ID` / `QQ_APP_KEY` | 无法绑定 QQ |
| `DANDANPLAY_APP_ID` / `_SECRET` | 少一个外部弹幕源（Animeko 那个免费源仍然可用） |
| `ADMIN_EMAILS` | 少一种管理员来源（仍可用 `npm run admin:grant:docker` 在库里授予）；没有管理员则**没人能处理举报、也没人能看到媒体源页** |
| `DANMAKU_BLOCKED_WORDS` | **弹幕无内容过滤**，见 §4 |

`NEXT_PUBLIC_DANMAKU_WS_URL` **保持为空**即可 —— 浏览器会按页面主机名自动推导网关地址。

### 1.2 启动

```bash
docker compose up -d
docker compose ps            # 三个服务都应为 healthy / Up
```

首次启动会自动完成建表（`migrate` 服务跑完即退出，这是正常的）。

### 1.3 首次初始化

```bash
# 建学校白名单（否则没人能注册）
docker compose exec postgres psql -U hitani -d hitani -c "
INSERT INTO \"School\" (id, name, domains) VALUES
  ('hit', '哈尔滨工业大学', ARRAY['hit.edu.cn','stu.hit.edu.cn'])
ON CONFLICT (id) DO NOTHING;"

# 演示账号（可选，方便你自测）
docker compose run --rm --entrypoint sh migrate -c "
  export DATABASE_URL='postgresql://hitani:\$POSTGRES_PASSWORD@postgres:5432/hitani?schema=public'
  npx tsx prisma/seed.ts"
```

### 1.4 验证

先在**本机**确认进程与数据库：

```bash
curl -s localhost:3100/api/health    # {"ok":true,"db":"ok",...}  ← 回环，nginx 也走这条
curl -s localhost:3102/              # {"service":"hit-ani-danmaku-gateway",...}
```

**真正的验收必须从另一台机器打域名**（服务器上测正常不代表别人能用）：

```bash
# 在另一台机器上
curl -s https://<你的域名>/api/health
```

> ⚠️ **不要再用 `http://<服务器IP>:3100` 做这项验收** —— §1.5 起 `web`/`gateway`
> 只绑回环（为了关掉一条绕过 TLS 的明文旁路），局域网**访问不到**这两个端口。
> 那个 `curl` 现在必然失败，而失败原因与站点是否正常**无关** —— 会把人引偏。
>
> 也就是说：**没有反向代理，站点在局域网里是不可达的**（见 §3）。

### 1.5 防火墙

**只放行 nginx 的 80 / 443**（正门就是它）：

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

`web`(3100) 与 `gateway`(3102) **只绑在回环地址**（compose 里写的是
`127.0.0.1:3100:3100`），因此**不需要**放行，局域网也访问不到。
> 早期这两个端口发布在 `0.0.0.0`，图上省事，实际给了局域网一条**绕过 TLS** 的路径：
> 那个源上会话 Cookie 不带 `Secure`（`resolveSecureCookie` 按**真实协议**判定，
> 见 §3 的对照实验），明文可被嗅探 —— 等于把 HTTPS 的收益直接抹掉。
> 现在 nginx 经环回转发，所以绑回环不影响任何功能。

数据库同理：compose 里它只绑回环（`127.0.0.1:55433`），局域网与其他机器都不可达。

> ⚠️ **实测过的事故**：开发用的数据库容器曾用 `docker run -p 55432:5432` 启动 ——
> `-p` 默认绑 `0.0.0.0`，等于把数据库放到整个局域网里。当时口令还是弱值 `hitani`，
> **实测从另一台机器直接连上并读出了全部数据**（含用户邮箱、学号、口令哈希、
> 以及 Bangumi access token 这类账户级凭据）。
>
> 用 `-p` 起数据库时务必写成 `-p 127.0.0.1:端口:5432`。
> 这与上面 3100/3102 是同一条教训：**发布端口前先问「这个端口需要被局域网看到吗」**。

**例外**：Jellyfin(3103) **保持发布在 `0.0.0.0`** —— 它按设计就是让浏览器/电视
**直连**的（见 §10 与 `JELLYFIN_PUBLIC_URL`），不经过本平台的代理。

### 1.6 常用操作

```bash
# ⚠️ 改了 prisma/schema.prisma 后，**必须重建全部镜像**：
#    migrate 服务用独立的构建阶段，只重建 web 会让容器库缺列/缺表 ——
#    而错误可能只在某个接口上以 500 的形式出现，很难第一时间定位。
npm run docker:rebuild

docker compose logs -f web        # 看日志
docker compose restart web        # 重启单个服务
docker compose up -d --build      # 更新代码后重建
docker compose down               # 停止（保留数据卷）
docker compose down -v            # 停止并**删除数据**（谨慎）
```

---

### 1.7 开机自启（把本机当服务器时）

依赖链上有三层，**只有中间那层会漏**：

| 层 | 现状 | 谁负责 |
| --- | --- | --- |
| Docker 守护进程 | 已 `enabled` | 系统 |
| **代理核心（Clash）** | ⚠️ 由 **GUI 程序**提供，靠桌面 autostart 启动 | **需要显式装成服务** |
| compose 容器 | 全部 `restart: unless-stopped`，守护进程起来后自动拉回 | Docker |

代理那层是唯一会漏的：`clash-verge` 是**图形程序**，而默认 `graphical.target`
且没有自动登录 —— 重启后停在登录界面，7897 永远不会监听，容器所有出站请求
`fetch failed`（症状与代码 bug 完全相同，见 `src/lib/net/egress.ts`）。

装成系统服务（**一条命令，幂等**）：

```bash
sudo bash deploy/install-autostart.sh
```

它做的事：装 `verge-mihomo.service`、把 GUI 的桌面自启改名为 `.disabled`
（否则登录后 GUI 会再拉一个核心抢 7897）、停掉 GUI 拉起的旧核心、
启用服务、等端口就绪、经代理取一次 `api.bgm.tv` 验证。

> ⚠️ 服务接管后，**改节点/订阅要 `sudo systemctl restart verge-mihomo`** 才生效。
> 想临时用 GUI 切节点，先 `sudo systemctl stop verge-mihomo`，用完再 start ——
> 否则两个核心会抢 7897。

**不需要自启的**：`migrate`（一次性任务，`restart: "no"`）、Jellyfin
（没插媒体盘时它是空库，现在是显式停止状态，重启后保持停止）。

---

## 出站网络：容器默认直连，代理需显式开启

**默认就是直连** —— 校内服务器部署时这一段不需要做任何事。

只有在「宿主需要代理才能出网」的机器上（例如开发机跑着 Clash / Mihomo），
容器才能借到代理。要做两件事，缺一不可：

```bash
# .env
HTTP_PROXY_URL="http://host.docker.internal:7897"

# 启动 socat 转发服务（它默认不起）
docker compose --profile proxy up -d
```

**为什么必须两个都做**：

1. **Clash 只监听宿主 `127.0.0.1`**，而容器里的 `127.0.0.1` 是它自己 ——
   所以需要 `proxy` 服务把它转发到容器可达的桥接地址。
2. **Node 的 `fetch`（undici）默认不读 `HTTP_PROXY`** —— 只有 `curl` 类工具会读。
   compose 里已内置 `NODE_USE_ENV_PROXY=1`。这一条极具误导性：
   同一个容器里 `curl https://api.bgm.tv` 是通的，而应用的 `fetch` 报
   `fetch failed`。

**排查症状**：探索页显示「Bangumi 搜索失败」、外部弹幕源 0/2 命中。
先确认是网络问题还是应用问题：

```bash
# 容器内直连测试（绕开代理配置）
docker compose exec web curl -sI --max-time 8 https://api.bgm.tv/v0/subjects/1

# 对比 Node fetch（会走 NODE_USE_ENV_PROXY 的配置）
docker compose exec web node -e "fetch('https://api.bgm.tv/v0/subjects/1').then(r=>console.log(r.status)).catch(e=>console.log('失败',e.cause?.code))"
```

### ⚠️ 构建期也需要出网

`docker compose build` 要拉 `node:22-slim`、跑 `npm ci`。若服务器连不上这些
注册表，会**卡在 build 而不是 run**。动手前先在服务器上验一次：

```bash
docker pull node:22-slim
curl -sI https://registry.npmjs.org | head -1
```

两者都通再继续；不通需要先解决服务器的出网（或在本机构建好镜像再传过去）。

---

## 2. 裸机 + systemd

不用 Docker 时，需要自己保证两个进程常驻。

### 2.1 依赖

```bash
# Node 22、PostgreSQL 16、openssl（Prisma 查询引擎需要）
sudo apt install -y postgresql-16 openssl

# 生产构建
npm ci
npx prisma generate
npm run build
npm run gateway:build        # 产出 dist/danmaku-gateway.mjs
```

### 2.2 两个 systemd 单元

```ini
# /etc/systemd/system/hit-ani-web.service
[Unit]
Description=hit-ani web
After=network.target postgresql.service

[Service]
Type=simple
User=hitani
WorkingDirectory=/opt/hit-ani
EnvironmentFile=/opt/hit-ani/.env
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
# 放宽文件描述符 —— WebSocket 长连接会占不少
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/hit-ani-gateway.service
[Unit]
Description=hit-ani danmaku gateway
After=network.target postgresql.service

[Service]
Type=simple
User=hitani
WorkingDirectory=/opt/hit-ani
EnvironmentFile=/opt/hit-ani/.env
Environment=NODE_ENV=production
# 跑打包产物而非 tsx —— 生产环境不需要 TypeScript 运行时
ExecStart=/usr/bin/node dist/danmaku-gateway.mjs
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hit-ani-web hit-ani-gateway
systemctl status hit-ani-web hit-ani-gateway
```

**两个单元必须用同一个 `SESSION_SECRET`** —— 网关靠它校验连接建立时的会话，不一致会导致「登录了但弹幕连不上」。

---

## 3. 反向代理（**必需**）

> `web` / `gateway` 只绑回环（见 §1.5），所以**没有反向代理 = 局域网里访问不到**。
> 本节不再是「可选」。

> **本机当服务器时**：直接把 `deploy/nginx-ani.conf` 装上就行 ——
> 它已经按下面两条硬要求写好，并处理了弹幕的同源路径：
>
> ```bash
> sudo cp deploy/nginx-ani.conf /etc/nginx/conf.d/ani.conf
> sudo nginx -t && sudo systemctl reload nginx
> ```
>
> ⚠️ 装之前确认 `server_name` 与你的域名一致，且**不要动** `conf.d/` 里
> 已有的站点（本机还有 `gal.conf`）。
>
> 这份配置里三处**必须理解**的地方：
> 1. `proxy_pass http://127.0.0.1:3102/;` 的**尾斜杠**负责剥掉 `/danmaku-ws`
>    前缀 —— 网关只匹配 `/danmaku/room/<id>`。实测对比：有尾斜杠 **101 握手
>    成功**，去掉就是 **404**。
> 2. `proxy_set_header X-Forwarded-Host/-Proto` 是**覆盖**而非透传
>    （见下面「两条硬要求」）。
> 3. `.env` 里要有 `NEXT_PUBLIC_DANMAKU_WS_URL="/danmaku-ws"`，且它**是构建期
>    常量** —— 改完必须 `docker compose build migrate web gateway`。

### 3.0 证书：必须用 DNS-01（本机解析到私网地址）

`ani.kajimi.cc` 指向 `10.249.61.10`（私网）。**Let's Encrypt 的验证服务器在公网上
路由不到它**，所以 HTTP-01 必然失败 —— 只能用 **DNS-01**（在 DNS 里放一条 TXT
记录，不需要任何入站可达性）。kajimi.cc 托管在 **GoDaddy**，凭据已在机器上：

```bash
# ⚠️ 三件事缺一不可，否则会以各种「连接失败/模块不存在」告终
sudo env HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  python3.10 /usr/local/bin/certbot certonly \
  -a dns-godaddy --dns-godaddy-credentials /etc/letsencrypt/godaddy.ini \
  -d ani.kajimi.cc --non-interactive --agree-tos
```

1. **代理**：本机没有直连外网的路由，而 `sudo` 默认重置环境变量 ——
   不显式传 `HTTPS_PROXY` 就连不上 GoDaddy API（实测：直连 `000`，
   走代理 `401`，401 说明网络通、只是没带凭据）。
2. **`python3.10`**：这台机器上 `/usr/local/bin/certbot` 的 shebang 曾指向
   `/usr/bin/python3`（现为 3.12），而 certbot 装在 **3.10** 的 dist-packages 里
   → `ModuleNotFoundError`。**已修好**（shebang 改成 `python3.10`），
   但换机器部署时要注意同样的坑：`pip` 装的 certbot 与系统 python 版本一旦漂移就失效。
3. **`-a dns-godaddy`** 而不是 `--dns-godaddy`：后者有歧义，
   会匹配到 `--dns-godaddy-credentials` 而报 `ambiguous option`。

#### 自动续期（原本完全没有）

这台机器上**没有任何续期定时器**（`certbot.timer` / `certbot.service` 都不存在），
所以 `gal.kajimi.cc` 的证书在 2026-09-01 **静默过期**了 —— 直到浏览器开始报
证书错误才会发现。

已补上 `deploy/certbot-renew.{service,timer}`：

```bash
sudo cp deploy/certbot-renew.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now certbot-renew.timer
```

- service 里带了 `Environment=HTTP_PROXY/HTTPS_PROXY` —— 续期要访问 GoDaddy API，
  而这台机器出网全靠代理。**这是最容易漏的一行**：漏了它续期会失败，
  而证书到期前没有任何提示。
- `ExecStartPost=systemctl reload nginx` —— 换了证书要重载，否则 nginx 仍用内存里的旧证书。
- timer 一天两次 + `Persistent=true`（关机错过的会在开机后补跑）。
- 实测：`certbot renew --dry-run` 对两张证书都成功；
  `systemctl start certbot-renew.service` 真跑一次同样 `status=0/SUCCESS`，
  且 **gal 那张已过期的证书被真的续成了有效**（`notBefore` 变成当天），
  证明 `ExecStartPost` 的 nginx 重载也生效。

### 3.0.1 本机访问自己的域名（Clash 规则）

**服务器自己**用浏览器打开 `http://ani.kajimi.cc/` 会失败（「未发送任何数据」），
即使域名与证书都正确。原因是 Clash 的规则表末尾是 `MATCH,节点选择` 兜底：

```
[TCP] ... --> ani.kajimi.cc:80 match Match using 节点选择[香港HKT-A]
```

**境外节点当然连不到校园私网地址**（10.249.61.10）。加一条 DIRECT 规则即可：

```bash
sudo bash deploy/clash-direct-campus.sh
```

脚本幂等，会插入 `DOMAIN-SUFFIX,kajimi.cc,DIRECT`、用核心自带的 `-t` 校验配置、
重启服务，最后打一次域名确认。生效后日志变成：

```
[TCP] ... --> ani.kajimi.cc:80 match DomainSuffix(kajimi.cc) using DIRECT
```

用 `DOMAIN-SUFFIX` 覆盖整个后缀，将来加子域名不用再改。

> ⚠️ `clash-verge.yaml` 是 Clash Verge **生成的运行期配置**。若你打开它的 GUI
> 并重新生成配置，这条规则**可能被冲掉** —— 症状是「浏览器又打不开自己的站点了」。
> 重跑上面的脚本即可恢复。

### 先说弹幕 WebSocket —— 它是最容易被漏掉的一半

**只代理 80/443 是不够的。** 弹幕网关是**独立服务、独立端口**（3102），
而浏览器端的地址默认从**页面地址**推导：

```
wss://<页面主机名>:3102
```

所以只把 443 代理到 3100 时，页面正常、**弹幕一直连不上**（且不报错，
只是「没有弹幕」）。两条出路，选一条：

### 方案 A（推荐）：同源路径，不必暴露 3102

`.env` 里设**同源路径**：

```env
NEXT_PUBLIC_DANMAKU_WS_URL="/danmaku-ws"
```

代理**必须剥掉这个前缀**再转发 —— 网关只匹配 `/danmaku/room/<id>`
（见 `src/server/danmaku-gateway.ts` 的正则），把 `/danmaku-ws/danmaku/room/1`
原样丢过去会被拒绝升级。

Caddy（`handle_path` 会剥前缀）：

```caddyfile
ani.example.edu.cn {
    handle_path /danmaku-ws/* {
        reverse_proxy localhost:3102
    }
    reverse_proxy localhost:3100
}
```

Nginx（`proxy_pass` 带**尾斜杠**才会剥前缀）：

```nginx
location /danmaku-ws/ {
    proxy_pass http://127.0.0.1:3102/;   # ← 尾斜杠是关键
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;            # WS 是长连接，不能按默认 60s 断
}
location / {
    proxy_pass http://127.0.0.1:3100;
}
```

好处：协议与端口都跟随页面，**证书只用管一张**，3102 不必对外开放；
而且换域名时不用改任何配置（地址是从页面推导的）。

### 方案 B：把 3102 也暴露出去

保持默认推导，但要让 `wss://<域名>:3102` 真的能连上 ——
**HTTPS 页面连 `ws://` 会被浏览器直接拦掉**，所以 3102 也得配 TLS 证书。
一般不值得，除非你本来就对 3102 做了终结。

### ⚠️ `NEXT_PUBLIC_*` 是**构建期**烘焙的

与 `APP_BASE_URL` 不同：改 `NEXT_PUBLIC_DANMAKU_WS_URL` / `_WS_PORT`
**必须重新构建镜像**，只改 `.env` 再 `up -d` **不生效**。

```bash
docker compose build web gateway && docker compose up -d
```

验证是否生效（构建后，在服务器上）：

```bash
docker compose exec web printenv NEXT_PUBLIC_DANMAKU_WS_URL
```

漏掉这一步的症状与方案选错完全一样（页面正常、弹幕不动），
所以改完一次就把这条命令跑一遍。

---

## 4. 上线前必办

| 事项 | 为什么 |
| --- | --- |
| **配置邮件发送**（`SMTP_*` 或 `EMAIL_API_*`） | **注册强制要求邮箱验证码**，不配则注册整体不可用。见 §1.1 —— 这是唯一会让「功能整个消失」的配置项 |
| **配置 `DANMAKU_BLOCKED_WORDS`** | 弹幕/评论/短评/昵称都靠它过滤。留空等于没有任何内容管控，违规内容会直接进所有人屏幕，法律风险落在部署方（学校） |
| **授予至少一个管理员** | 举报处理后台在 `/admin/reports`，**仅管理员可见**。一个都没有等于举报无人处理。用 `npm run admin:grant <邮箱或学号>` 授予（改 `User.isAdmin`，**不需要重启**）。见下一节「管理员与举报处理」 |
| **替换 `SESSION_SECRET` 与 `POSTGRES_PASSWORD`** | 默认值仅供开发 |
| **配好学校白名单** | 否则没人能注册（注册按邮箱域名判定学校归属） |
| **确认内容策略** | 抓取源由你选择，相应责任也在你。见 `docs/MEDIA.md` §6.4 |

---

## 管理员与举报处理

**举报是有处理后台的**：管理员登录后侧栏出现「举报」→ `/admin/reports`。

授予管理员（两种来源取**并集**，改哪个都行）。

**Docker 部署用这一条**（在仓库根目录执行，读的是**容器库**）：

```bash
npm run admin:grant:docker -- --list                     # 查看当前管理员
npm run admin:grant:docker -- 2024311524                 # 学号或邮箱
npm run admin:grant:docker -- someone@stu.hit.edu.cn
npm run admin:grant:docker -- 2024311524 --revoke        # 撤销
```

> ⚠️ **别在服务器上直接跑 `npm run admin:grant`**。它用宿主 `.env` 的
> `DATABASE_URL` —— 在那个文件里那是**开发库**（`127.0.0.1:55432`）。
> `:docker` 那条走 `migrate` 镜像 + 挂载脚本，因此连的是 compose 里的库。

- 改的是 `User.isAdmin`，**不需要重启**（与 `ADMIN_EMAILS` 不同 —— 那个要改
  `.env` 再重启，适合「配置级」的管理员）。
- 为什么用 `migrate` 镜像而不是 `web`：`.dockerignore` 把 `scripts/` 排除了
  （只留 `build-gateway.mjs`），所以**生产镜像里没有这个脚本**；而 `migrate`
  是唯一保留 `tsx` 与 devDependencies 的镜像。挂载单个脚本即可，
  不必把运维工具塞进生产镜像。
- **没有管理员 = 举报无人处理。** 后台页面本身有守卫：非管理员访问会被
  重定向（`/admin/reports` 的 API 返回 401），所以一个都不授予就等于
  举报只进库、没人能看见。

### 举报的处理方式

后台有两个动作，按钮文案写明后果：

| 动作 | 效果 |
| --- | --- |
| **屏蔽这条弹幕** | 事务内同时把举报标为已处理 **且** 把弹幕本体置为不可见（所有读路径都过滤）。弹幕行**仍保留**，以便追溯与误判恢复 |
| **驳回举报** | 只把举报标为已处理，弹幕保留 |

**刻意不做物理删除**：屏蔽已经让弹幕对所有用户不可见，而保留行才能事后
追溯（谁在什么时候举报了什么）以及恢复误判。手工 `DELETE` 是不必要的，
也会丢掉这些信息。

---

## 5. 上游写入的闸门（重要）

平台**可以**把站内操作镜像写入用户的 Bangumi 账号 —— 收藏状态、评分、短评、
单集进度。这是产品功能（「在站内标记也能同步到 BGM」），但它意味着
**测试写入会污染真实数据**。

**现在是「用户显式开启才同步」（`User.mirrorToBgm`，默认关闭）。** 默认关闭
是因为写上游不可撤销 —— 会以本站的值**覆盖**用户在 Bangumi 上已有的内容，
默认替他打开等于替他做了决定。用户可在设置页开启。

### 5.1 真实事故

开发期间我用 `curl` 以**用户本人账号**（已绑定 Bangumi）测 `PUT /api/collections`，
body 里带的是测试文案 —— 于是这条测试数据真的写进了用户的 BGM 账号，
**覆盖了他自己写的短评**（subject 101437，忍者杀手）。

根因是设计缺陷：`collection-actions.ts` 里 `if (bgmBound)` 就直接发请求，
**没有任何闸门**。因此「拿真实账号做接口冒烟」必然污染真实数据，
而且事后无法从代码看出发生过什么。

### 5.2 现在的三道防护

| 防护 | 行为 |
| --- | --- |
| **用户偏好**（`User.mirrorToBgm`，默认关闭） | 用户没在设置里开启时，一律不写上游。这是**主闸** |
| **测试账号自动拒绝** | 邮箱匹配 `^(smoke\|test\|e2e)([-._+]\|@)` 或 `[-._+](smoke\|test\|e2e)@` 的账号，一律不写上游 |
| **运维硬闸** | `BGM_MIRROR_ENABLED=0` 关闭所有上游镜像，**压过用户偏好**（跑写库测试时用） |

判定顺序：**运维硬闸 → 测试账号 → 用户偏好**（安全优先）。
界面会区分「你没开这个功能」（静默）与「开了但被管理员挡住」（提示），
不会把 `BGM_MIRROR_ENABLED` 这种内部术语显示给用户。

再加**审计日志**：每次成功的上游写入都打一行
`[bgm-mirror] <邮箱> → subject=<id> {字段}` —— 出事时能查「到底改了什么」。
这次事故的排查难点正是没有这条日志。

### 5.3 运维约定

- **不要用真实账号做写库测试。** 需要测镜像功能时，用一个**专门绑定 BGM 的测试账号**，
  或临时设 `BGM_MIRROR_ENABLED=0`。
- 冒烟脚本（`npm run smoke`）已改用自建账号，不会触达上游。
- 若怀疑上游被污染，查日志里的 `[bgm-mirror]`，比 `grep` 代码可靠。

## 6. 已知缺口

诚实列出，避免上线后才发现：

| 缺口 | 影响 | 变通 |
| --- | --- | --- |
| 无数据库自动备份 | 卷损坏即丢数据 | `docker compose exec postgres pg_dump -U hitani hitani > backup.sql`，建议加 cron |
| 无日志聚合 | 排查只能 `docker compose logs` | 单机规模够用 |
| 无监控告警 | 服务挂了不会通知你 | 可用外部探针打 `/api/health` |
| 限流为进程内实现 | 网关多副本时失效 | 单副本部署不受影响 |

---

## 7. 上游响应缓存（省配额）

上游有配额也会限流，而**有些页面原先每次访问都打一次上游**。下表是本项目的
全部缓存层：

| 内容 | 上游 | 内存 | 数据库 | 说明 |
| --- | --- | --- | --- | --- |
| 外部弹幕 | Animeko / dandanplay | 5 分钟 / 40 集 LRU | **6 小时**（`DanmakuCache`） | 见 §7.1 |
| 新番时间表 | BGM `searchSubjects` | — | **6 小时**（`UpstreamCache`） | 档期不会按分钟变 |
| 首页 Hero + 推荐 | BGM `searchSubjects` | — | **1 小时**（`UpstreamCache`） | 按收藏人数排的「趋势」，用户预期较新 |
| 媒体资源索引 | 各抓取源 | 10 分钟 | — | 见 `lib/media/resource-service.ts` |
| BGM 评论 | BGM | — | 有（`BgmCommentsCache`） | |
| 条目元数据/人员 | BGM | — | 有（`detailSyncedAt` / `staffSyncedAt`） | |
| **排行榜** | **无（本地库）** | — | — | 实测 **1.21ms**，不消耗任何上游配额 |

### 7.1 弹幕缓存（早已有，不用改）

读路径是三层：**内存 LRU（5 分钟 / 40 集）→ 数据库（6 小时）→ 上游**。
数据库那层是关键 —— 内存层随容器重启即失效，而重启在这个部署里是常态。
落库才真正挡住「每次重启全量回源」。

### 7.2 上游响应缓存（`UpstreamCache`）

`src/lib/cache/upstream-cache.ts`：`namespace + key → gzip(JSON)`，带 TTL。

三条行为值得知道：

1. **新鲜命中时根本不调 loader** —— 省配额就靠这一步，有测试盯着
   （`tests/upstream-cache.test.ts`，含反向验证）。
2. **上游失败时吃陈旧数据**（上界 3 天）。这个部署的上游经常不可用，
   时间表原先 `.catch(() => null)` → 整页空档期表；**稍旧的数据几乎总是比空页面有用**。
3. **只缓存确定性查询**。首页缓存的是 `recommendQuery()`（近一年动画按收藏人数，
   且强制 `nsfw: false`）—— 对所有人是同一份数据，一天一个键。
   **搜索结果不缓存**：键由关键词/标签/排序/页码组合，命中率极低，只会塞满一次性条目。

实测（本机 HTTP，`journalctl -u verge-mihomo | grep -c api.bgm.tv` 计数）：

| | 首次 | 之后 |
| --- | --- | --- |
| 首页 | 1165 ms（2 次上游） | **57 ms / 0 次上游** |
| 时间表 | 383 ms（1 次上游） | **58 ms / 0 次上游** |
| 连续 9 次访问 | — | **新增上游请求 0 次** |

### 7.3 清理

读路径已做惰性删除（访问到过期条目时顺带删掉），定时任务补全「不再被访问」的条目：

```bash
npm run cache:prune:docker     # ⚠️ Docker 部署用这个
```

> ⚠️ **别用 `npm run cache:prune`**（不带 `:docker`）—— 它读宿主 `.env` 的
> `DATABASE_URL`，在 Docker 部署里那常常指向**开发库**，于是「清理成功」而
> 容器库里的缓存一条没动。这与 `admin:grant` 是同一个坑（§ 管理员与举报处理）。

建议加进 crontab，每天凌晨一次：

```
0 3 * * * cd /opt/hit-ani && npm run cache:prune:docker >> /var/log/hit-ani-cache.log 2>&1
```

清理用的是**陈旧上界**而不是各缓存的 TTL —— 超过 TTL 但未到上界的条目在
「上游偶发不可用」时仍有用，按 TTL 清会把这份兜底数据提前删掉。

---



外部弹幕（Animeko / dandanplay）落库缓存，**不需要额外配置**。

| 层 | 存活期 | 作用 |
| --- | --- | --- |
| 内存 LRU（40 集） | 进程内 5 分钟 | 挡同一集的高频重复请求 |
| **数据库** `DanmakuCache` | 6 小时 | 挡回源，**重启不丢** |

为什么必须落盘：dandanplay 的使用约定（§10）明确要求缓存，并会对调用量大的
应用限流。而内存层只有 40 集、TTL 5 分钟，重启即全失 —— 实际上几乎每次都回源。

**体积**：弹幕 JSON 高度重复，gzip 实测 **93% 压缩率**（3000 条 229KB → 16KB）。
1 万集约 0.5GB，放数据库（内部盘）而非外挂硬盘更合适 ——
能随其余数据一起备份，也不受外挂盘掉线影响。

运维：

```bash
# 观察规模
psql ... -c 'SELECT count(*), pg_size_pretty(sum(length(payload))::bigint) FROM "DanmakuCache";'

# 强制刷新（例如上游数据出问题）
psql ... -c 'DELETE FROM "DanmakuCache";'

# 清理过期条目（读路径已惰性删除，这里补全「不再被访问」的）
npm run cache:prune
```

---

## 8. 备份与恢复

```bash
# 备份
docker compose exec -T postgres pg_dump -U hitani hitani > hitani-$(date +%F).sql

# 恢复
cat hitani-2026-09-23.sql | docker compose exec -T postgres psql -U hitani -d hitani
```

需要持久化的只有 `pgdata` 卷。抓取源清单（`data/animeko-sources.json`）是宿主机上的文件，
不在卷里 —— 若用了它，一并备份。

---

## 9. 数据导入策略（影响部署时的操作）

Bangumi 数据采用**两层缓存**，这决定了你不需要做任何预热：

| 层 | 什么时候写入 | 成本 |
| --- | --- | --- |
| **轻量数据**（条目骨架 + 收藏关系） | 用户点「一键导入」时 | 仅分页拉收藏：377 条 = **4 次请求** |
| **完整数据**（简介 + 章节 + 单集进度） | 用户**首次打开**某个条目时 | 该条目 3 次请求，之后走缓存 |

依据是收藏列表接口内嵌的 `SlimSubject`（含封面 / 名称 / 评分），足以渲染追番列表。
因此导入是秒级的，不会为几百个收藏打出上千次请求。

**部署时无需预热数据库** —— 学生第一次打开某部番会略慢（约 1 秒），之后就是缓存命中。
这也是为什么容器可以放心用空库启动。

---

## 10. 本地媒体库（Jellyfin）

外挂硬盘上的媒体文件由 Jellyfin 提供服务，学生通过 hit-ani 的「在这里看」面板播放。

### 8.1 架构与边界

```
学生浏览器 ──播放请求──> Jellyfin :3103   ← 视频字节走这条线，不经过 web/gateway
          └─页面/API──> hit-ani :3100
```

**视频字节不经过 hit-ani** —— 因此不消耗对外带宽（校园网内走 LAN）。
也正因如此，平台的角色是「媒体服务器运营方」，**收录什么内容由部署方决定并承担责任**
（见 `docs/MEDIA.md` §6.4）。

### 8.2 媒体库目录

```
<外挂硬盘>/hit-ani/media/
├── .library-root          ← 哨兵文件：健康检查靠它判断硬盘是否挂载
├── anime/                 ← 剧集（Jellyfin 的 tvshows 类型）
│   └── 作品名 (年份)/Season 01/作品名 - S01E01.mp4
└── movies/                ← 剧场版（movies 类型）
```

**目录命名很重要**：Jellyfin 靠「标题 (年份)」识别作品。
`npm run media:curation` 生成的清单已按这个规范给出目录名。

### 8.3 选片清单

两条标准（`npm run media:curation`）：

| 标准 | 依据 |
| --- | --- |
| 有人观看过 | 本地库里有「看过 / 在看」收藏，或存在单集观看进度 |
| 本季高分 | 当前季度播出且 Bangumi 评分 > 7（可调 `--min-score=`） |

**清单只是候选池，不是「一次收完」**。实测两条标准产生 398 部 / 6288 集，
按 500MB/集估算需 **3070 GB**，而常见外挂盘只有 418 GB —— 7 倍差距。
脚本会算出「当前空间能收多少」，按评分降序收满为止。

> ⚠️ 脚本**不下载任何内容**。它只回答「该收哪些」，资源获取方式由部署方决定。

### 8.4 ⚠️ 挂载地址：容器部署必填「浏览器侧地址」

容器部署时，hit-ani 的服务端走 Docker 内部服务名（`http://jellyfin:8096`），
但**学生浏览器解析不了这个名字** —— 播放链接会指向容器内部，点开是黑屏。

因此在「设置 → 我的媒体服务器」里要分别填：

| 字段 | 值 | 用途 |
| --- | --- | --- |
| 服务器地址 | `http://jellyfin:8096` | 服务端调 API |
| **浏览器侧地址** | `http://<服务器IP>:3103` | **生成播放链接给学生用** |

只填前者时界面会给出警告。

### 8.5 ⚠️ 外挂硬盘的可靠性

USB 硬盘是**可拔插**的，而 Docker 挂载有静默失败模式：若盘未挂载，
Docker 会在挂载点创建一个**空目录** —— Jellyfin 看到空媒体库，**且不报错**。

本项目的防护：

1. **哨兵文件**：媒体库根的 `.library-root`。Jellyfin 容器的健康检查同时检查
   它是否存在 —— 盘没挂上时容器变 `unhealthy`，把静默失败变成可见告警。
2. **数据不放在外挂盘**：Jellyfin 的配置与缓存、数据库都在内部盘的 Docker 卷里。
   盘掉线不会连带丢掉元数据。

**仍需你做的**（需要 sudo，我无法代做）：

```bash
# 让硬盘开机自动挂载，且挂载失败时不让系统卡住
sudo blkid /dev/sda1                      # 取 UUID
sudo nano /etc/fstab                      # 加一行：
UUID=<你的UUID>  /media/kajimi/kajimi  ntfs3  rw,nosuid,nodev,uid=1000,gid=1000,iocharset=utf8,nofail,x-systemd.device-timeout=10  0 0

# 不写 fstab 的话，盘只在「用户登录后」由 udisks2 挂载 ——
# 服务器重启后若无人登录，Jellyfin 就会看到空库。
```

### 8.6 NTFS 注意事项

外挂硬盘常见 NTFS（ntfs3 驱动）。实测结论：

| | 结果 |
| --- | --- |
| 权限 | 由挂载参数统一映射为 `uid=1000,gid=1000`；`chmod` 对目录**生效**，但属主不可改 |
| 容器写入 | uid 1001 在 `777` 目录下可写、`755` 下被拒 —— **Jellyfin 只读挂载即可** |
| **Postgres 数据目录** | ❌ **不可用** —— `initdb` 报 `could not change permissions` |

因此：**媒体放外挂盘，数据库绝不放**。

---

## 11. 关于数据库迁移

目前用 `prisma db push`（直接同步 schema），**不是** `prisma migrate`（版本化迁移）。

理由：项目从零开发，尚无迁移历史，`db push` 对单实例部署足够且不需要维护迁移文件。

**什么时候该切到 migrate**：

- 开始有**生产数据不能丢**时（`db push` 可能要求删列/重建表）
- 需要多实例或多环境（开发/生产 schema 需对齐）
- 需要审计 schema 变更历史

切换方式：`npx prisma migrate dev --name init` 生成初始迁移，之后 compose 里的
`migrate` 服务改用 `npx prisma migrate deploy`。

---

### ⚠️ 部署前必跑：确认 `.env` 里的代理和 profile 不对

`.env` 是**整份复制**到服务器的（里面有 `SESSION_SECRET`、SMTP 凭据，必须跟着走），
所以开发机上为 Clash 写的 `HTTP_PROXY_URL` 极易跟着过去。服务器上没有那个代理时，
容器往外发的请求**全部** `fetch failed`，而 `NODE_USE_ENV_PROXY=1` 会让 `curl`
能通、应用不通 —— 与「代码有 bug」的症状一模一样。

**上服务器后、`up -d` 之前，先看代换后的实际值：**

```bash
docker compose config | grep -iE 'proxy|profile'
```

一条命令同时抓两类问题：

- 输出里出现 `host.docker.internal:7897` 或 `127.0.0.1:7897` → **`.env` 残留了本机代理**，
  把 `HTTP_PROXY_URL=` 与 `BUILD_PROXY_URL=` 都留空；
- 期望有代理却没出现 → 变量没生效（多半是被 `${VAR:-default}` 这类写法吃掉了）。

服务器上还应确保 **没有设 `COMPOSE_PROFILES`**，否则 `proxy` 服务会被
自动拉起，而它转发到一个不存在的地址，会一直崩溃重启。

应用启动时也会主动喊一声（`src/lib/net/egress.ts`）——
`docker compose logs web | head -20` 能看到 `[egress] 出站直连（未配置代理）`
或一段警告。**看到那段警告就别再往下查代码了，先修配置。**

---

## 反向代理：两条硬要求

如果在本服务前面加**自己的**反向代理（nginx / Caddy / 校园网网关），必须做到：

### 1. 必须**剥掉**入站的 `X-Forwarded-*`，再由代理自己设置

```
proxy_set_header X-Forwarded-Host  $host;    # 先覆盖（不是 pass 透传）
proxy_set_header X-Forwarded-Proto $scheme;
```

**为什么**：本服务在需要推断对外地址时会读 `X-Forwarded-Host`（仅当
`TRUST_PROXY_HEADERS=1`）。若反代直接透传客户端的同名头，任何能到达该端口的
请求就能伪造它，从而**改写重定向目标**（开放重定向）。

代码侧的默认是**不信任**这两个头（`TRUST_PROXY_HEADERS` 未设即关闭），
但「默认关」只保护没开代理的部署 —— 一旦你开了代理并设了
`TRUST_PROXY_HEADERS=1`，剥除入站头的责任就在配置里。

### 2. 更省事的做法：设 `APP_BASE_URL`

```
APP_BASE_URL="http://hit-ani.example.edu"
```

设了它，服务**完全忽略请求头**，所有重定向都用这个地址 —— 既没有伪造面，
也不受「用户从哪个地址访问」影响。

对 OAuth 尤其重要：`redirect_uri` 必须在 bgm.tv 上登记成**唯一固定值**，
按访问地址推断必然时对时错。设了 `APP_BASE_URL` 后，`BGM_REDIRECT_URI`
不填也能正确推导。

### 排查：外部地址相关的问题

```
npm run check:credentials -- --bgm      # 会打印当前生效的 redirect_uri
```

服务端日志里搜 `[request-origin]`（若后续加了日志）或直接用不同 `Host`
头 curl 一下，看重定向的 `Location` 指向哪里。
