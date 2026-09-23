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

**按需填**（留空则该功能不可用，不影响其它部分）：

| 变量 | 留空的影响 |
| --- | --- |
| `BGM_CLIENT_ID` / `BGM_CLIENT_SECRET` | 无法绑定 Bangumi，也就无法一键导入收藏 |
| `QQ_APP_ID` / `QQ_APP_KEY` | 无法绑定 QQ |
| `DANDANPLAY_APP_ID` / `_SECRET` | 少一个外部弹幕源（Animeko 那个免费源仍然可用） |
| `ADMIN_EMAILS` | 没有管理员，无法配置抓取源 |
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

```bash
curl -s localhost:3100/api/health    # {"ok":true,"db":"ok",...}
curl -s localhost:3102/              # {"service":"hit-ani-danmaku-gateway",...}
```

**从另一台机器**用局域网地址访问（这一步必须做 —— 服务器上测正常不代表别人能用）：

```bash
# 在另一台机器上
curl -s http://<服务器IP>:3100/api/health
```

### 1.5 防火墙

两个端口都要放行：

```bash
sudo ufw allow 3100/tcp   # 页面 + API
sudo ufw allow 3102/tcp   # 弹幕 WebSocket
```

数据库**不需要**放行 —— compose 里它只绑在回环地址（`127.0.0.1:55433`），
局域网与其他机器都不可达。

> ⚠️ **实测过的事故**：开发用的数据库容器曾用 `docker run -p 55432:5432` 启动 ——
> `-p` 默认绑 `0.0.0.0`，等于把数据库放到整个局域网里。当时口令还是弱值 `hitani`，
> **实测从另一台机器直接连上并读出了全部数据**（含用户邮箱、学号、口令哈希、
> 以及 Bangumi access token 这类账户级凭据）。
>
> 用 `-p` 起数据库时务必写成 `-p 127.0.0.1:端口:5432`。

### 1.6 常用操作

```bash
docker compose logs -f web        # 看日志
docker compose restart web        # 重启单个服务
docker compose up -d --build      # 更新代码后重建
docker compose down               # 停止（保留数据卷）
docker compose down -v            # 停止并**删除数据**（谨慎）
```

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

## 3. 反向代理（可选）

想用域名 + HTTPS 时。以 Caddy 为例（自动签发证书）：

```caddyfile
ani.example.edu.cn {
    # 页面与 API
    reverse_proxy localhost:3100

    # 弹幕 WebSocket —— 必须单独处理，否则升级握手会失败
    @ws path /danmaku/room/*
    reverse_proxy @ws localhost:3102
}
```

用 Nginx 时对应配置：

```nginx
location /danmaku/room/ {
    proxy_pass http://127.0.0.1:3102;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;    # WS 是长连接，不能按默认 60s 断
}

location / {
    proxy_pass http://127.0.0.1:3100;
}
```

> 若 WS 挂在与页面**不同**的域名/端口下，需要在 `.env` 里显式设置
> `NEXT_PUBLIC_DANMAKU_WS_URL` 并**重新构建** —— 它是构建期常量。

---

## 4. 上线前必办

| 事项 | 为什么 |
| --- | --- |
| **配置 `DANMAKU_BLOCKED_WORDS`** | 弹幕/评论/短评/昵称都靠它过滤。留空等于没有任何内容管控，违规内容会直接进所有人屏幕，法律风险落在部署方（学校） |
| **处理举报** | 学生能举报，但目前**没有处理后台** —— 举报会积压在 `DanmakuReport` 表里无人处理。见 §5 |
| **替换 `SESSION_SECRET` 与 `POSTGRES_PASSWORD`** | 默认值仅供开发 |
| **配好学校白名单** | 否则没人能注册（注册按邮箱域名判定学校归属） |
| **确认内容策略** | 抓取源由你选择，相应责任也在你。见 `docs/MEDIA.md` §6.4 |

---

## 5. 已知缺口

诚实列出，避免上线后才发现：

| 缺口 | 影响 | 变通 |
| --- | --- | --- |
| **举报处理后台未实现** | 举报只入库，无人能处理 | 手工 SQL：`UPDATE "Danmaku" SET status=1 WHERE id='...'` 屏蔽某条 |
| 无数据库自动备份 | 卷损坏即丢数据 | `docker compose exec postgres pg_dump -U hitani hitani > backup.sql`，建议加 cron |
| 无日志聚合 | 排查只能 `docker compose logs` | 单机规模够用 |
| 无监控告警 | 服务挂了不会通知你 | 可用外部探针打 `/api/health` |
| 限流为进程内实现 | 网关多副本时失效 | 单副本部署不受影响 |

---

## 6. 备份与恢复

```bash
# 备份
docker compose exec -T postgres pg_dump -U hitani hitani > hitani-$(date +%F).sql

# 恢复
cat hitani-2026-09-23.sql | docker compose exec -T postgres psql -U hitani -d hitani
```

需要持久化的只有 `pgdata` 卷。抓取源清单（`data/animeko-sources.json`）是宿主机上的文件，
不在卷里 —— 若用了它，一并备份。

---

## 7. 数据导入策略（影响部署时的操作）

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

## 8. 关于数据库迁移

目前用 `prisma db push`（直接同步 schema），**不是** `prisma migrate`（版本化迁移）。

理由：项目从零开发，尚无迁移历史，`db push` 对单实例部署足够且不需要维护迁移文件。

**什么时候该切到 migrate**：

- 开始有**生产数据不能丢**时（`db push` 可能要求删列/重建表）
- 需要多实例或多环境（开发/生产 schema 需对齐）
- 需要审计 schema 变更历史

切换方式：`npx prisma migrate dev --name init` 生成初始迁移，之后 compose 里的
`migrate` 服务改用 `npx prisma migrate deploy`。
