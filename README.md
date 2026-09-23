# hit-ani

校内动漫平台（Web）。基于 Bangumi 元数据做「找番 / 追番 / 看番」，并提供 BGM 没有的能力：
**校内弹幕、校内评论与影评**。

- 条目 / 章节 / 检索 / 收藏导入来自 [Bangumi API](https://github.com/bangumi/api)
- 弹幕与评论影评由本项目自建（BGM `v0` 无弹幕接口，旧版评论接口已 404）
- 方案与范围决策见 [`docs/PLAN.md`](docs/PLAN.md)

---

## 快速开始

```bash
# 1. 依赖
npm install

# 2. 环境变量
cp .env.example .env      # 填写 DATABASE_URL、SESSION_SECRET，BGM/QQ 凭据可留空

# 3. 数据库（需一个 PostgreSQL 16）
npm run db:push
npm run db:seed           # 写入 hit / demo-other 两所学校 + episode 8 的测试弹幕

# 4. 两个进程（弹幕网关必须独立常驻）
npm run dev               # http://localhost:3100
npm run gateway           # ws://localhost:3102
```

种子账号（密码均为 `hitani-dev-2026`）：

| 账号 | 学校 | 用途 |
| --- | --- | --- |
| `alice@hit.edu.cn` | `hit` | 本校视角 |
| `bob@example.edu` | `demo-other` | 外校视角，用于验证「只看本校」隔离 |

打开 <http://localhost:3100/subjects/8> 即可看到弹幕面板与校内筛选开关。

## 验证

```bash
npm run typecheck   # tsc --noEmit
npm test            # 纯逻辑单测（197 项：弹幕/限流/时间表/收藏/超时/匹配链/SSRF/解析/Jellyfin）
npm run bgm:check   # Bangumi 客户端联调（16 项，只读，无需授权）
npm run bgm:bind-check  # Bangumi 绑定落库验证（19 项，上游打桩，需可写 DB）
npm run smoke       # 端到端冒烟（45 项，需 dev + gateway 已启动）
```

`npm run smoke` 覆盖真实链路：Bangumi 直连、注册登录、弹幕 REST 与 WebSocket、
**跨校投递隔离**、评论/影评发布与校内筛选、单集进度读写、新番时间表。

> 注意：`npm run build` 与 `npm run dev` 共用 `.next` 目录，不要同时运行，
> 否则 dev server 会出现 `MODULE_NOT_FOUND`。构建后请重启 dev。

## 目录

```
src/
  app/
    page.tsx                     找番（BGM 搜索，SSR）
    schedule/page.tsx            新番时间表（周视图，可前后翻周）
    subjects/[id]/page.tsx       条目详情：章节 + 进度 + 弹幕 + 评论
    library/page.tsx             我的追番（按收藏状态分组）
    login|register|settings/     账号与绑定
    sources/page.tsx             媒体源管理
    api/
      search/                    条目搜索
      schedule/                  时间表（按 air_date 区间检索聚合）
      subjects/[id]/             条目详情（本地缓存优先，回源落库）
      danmaku/                   弹幕 REST：拉取 / 发送
      reviews/                   评论 / 影评
      progress/                  单集进度读写（本地 + BGM 回写）
      auth/register|login/       邮箱 + 学号注册登录
      auth/bgm/…                  Bangumi OAuth2 绑定
      auth/qq/…                   QQ 互联绑定
      library/import/             一键导入 BGM 收藏与进度（快照 + 游标，可续）
      collections/               条目收藏状态读写（五种状态）
      media/sources/             媒体源 CRUD
      media/search/              多源搜索
  components/
    danmaku-panel.tsx            canvas 弹幕渲染 + WS 客户端
    review-panel.tsx             评论 / 影评
    episode-workspace.tsx        章节选择 + 进度标记容器
    collection-picker.tsx        五种收藏状态选择器
    source-manager.tsx           抓取源管理 + 试搜
    jellyfin-manager.tsx         Jellyfin 连接管理
    jellyfin-panel.tsx           条目页「在这里看」面板
    video-player.tsx             播放器 + 弹幕叠加层
    external-resources.tsx       外部资源索引（按集分组，跳转外站）
    settings-client.tsx          绑定 / 解绑 / 导入操作
  lib/
    bgm/                         生成的类型 + 客户端 + 导入任务
    media/types.ts               媒体资源抽象（借鉴 Animeko Media/ResourceLocation）
    collection.ts                收藏状态权威映射（2=看过、3=在看）
    media/                       媒体源：抓取源 + Jellyfin 集成（带 SSRF 防护）
      jellyfin.ts                Jellyfin/Emby 客户端（认证 / 搜索 / 剧集 / 直连地址）
      jellyfin-service.ts        连接管理 + 条目匹配（复用弹幕的 Levenshtein）
      resource-service.ts        外部资源索引（带 10 分钟缓存 + 按集分组）
      url-safety.ts              SSRF 防护（DNS 全解析校验 + fake-IP 受控放行）
      source-config.ts           配置模型 / 关键词处理 / URL 模板 / 预设
      extract.ts                 纯函数解析（CSS 选择器 / RSS / Atom / 正则提链）
      fetcher.ts                 网络层（逐跳重定向校验 / 超时 / 大小上限 / 限速）
      service.ts                 CRUD + 多源编排
    collection-actions.ts        收藏状态写路径（本地 + BGM 镜像）
    danmaku/                     领域类型 / 纯逻辑 / 仓储 / 限流 / 校验
      dandanplay.ts              dandanplay v2 客户端（签名 + 7 端点 + p 字段解析）
      matching.ts                弹幕源匹配降级链（Levenshtein + 别名 + 前缀变体）
    review/                      评论影评仓储
    auth/                        会话 / 口令 / 学校准入 / 两个 OAuth
    schedule.ts                  时间表周区间计算
  server/
    danmaku-gateway.ts           弹幕 WebSocket 网关（独立进程）
prisma/
  schema.prisma                  数据模型
  seed.ts                        开发种子数据
tests/                           单测
scripts/smoke.ts                 端到端冒烟
docs/PLAN.md                     技术方案与 MVP 范围
docs/MEDIA.md                    视频获取/播放/弹幕源调研与设计决策
.bgm-v0.yaml                     Bangumi OpenAPI 规范（类型生成的唯一来源）
```

## 架构要点

### 弹幕网关为什么必须独立进程

WebSocket 是长连接 + 常驻内存广播，Serverless 函数有时限且无持久连接。
因此 `src/server/danmaku-gateway.ts` 是**独立常驻服务**，与 Next.js 分离部署。

- 拉取：`GET /api/danmaku?episodeId=&fromMs=&toMs=&schoolOnly=`
- 实时：`WS /danmaku/room/<episodeId>?schoolOnly=true`
- 网关不可用时，前端自动降级为 REST 模式（面板会显示「REST 模式」）

### 「只看本校」是索引命中，不是事后过滤

`Danmaku` / `Review` 都冗余存 `schoolId`，并建有复合索引：

```prisma
@@index([episodeId, schoolId, playTimeMs])   // Danmaku
@@index([subjectId, schoolId, createdAt])    // Review
```

`schoolId` **只从会话解析**，客户端无法传参伪造。未登录访问 `schoolOnly=true` 返回 401。

### Bangumi 只提供元数据与「你自己的」数据

实测结论（见 `docs/PLAN.md` §1）：

- 可用：`POST /v0/search/subjects`、`GET /v0/subjects/{id}`、`GET /v0/episodes`、
  `GET /v0/users/{username}/collections`（公开可读）、章节进度读写（需 `write:collection`）
- 不可用：弹幕（接口不存在）、他人评论 / 影评（`/ep/{id}/comments`、`/subject/{id}/reviews` 均 404）
- 授权域 `bgm.tv/oauth/*` 与业务域 `api.bgm.tv` **不同**；`code` 有效期 60 秒，`access_token` 7 天

BGM 类型由 `.bgm-v0.yaml` 生成，禁止手写：

```bash
npm run bgm:types   # openapi-typescript .bgm-v0.yaml -o src/lib/bgm/schema.d.ts
```

导入任务串行 + 固定间隔 + 指数退避（BGM 未公布限流阈值，宁可慢不可封），
按 `subjectId` / `episodeId` upsert，可重复执行。

### 封面走本站代理

`next.config.ts` 配置 `images.remotePatterns`，封面经 `/_next/image` 由服务端拉取并缓存：

- 不把校内用户 IP 暴露给第三方
- 不受上游 referer 限制影响
- 服务端统一缓存，省校内带宽

首屏封面用 `priority` 立即加载，折叠区以下保持懒加载。

## 部署

```
[VPS / Railway / Render]
 ├── next start          :3100   SSR + API
 ├── danmaku-gateway     :3102   ← 必须常驻，不可放 Vercel
 └── postgres:16         :5432
```

反向代理（Caddy / Nginx）负责 TLS，并把 `/danmaku/room/*` 升级转发到网关。
生产环境务必替换 `SESSION_SECRET`，并通过 `NEXT_PUBLIC_DANMAKU_WS_URL` 指向
`wss://<域名>`。

最低 2C4G 可支撑单校规模。

## MVP 完成度

| 模块 | 状态 |
| --- | --- |
| 学校准入注册 / 登录（邮箱 + 学号） | ✅ |
| Bangumi OAuth 绑定 + 一键导入收藏与进度 | ✅ 代码完成（需自备 BGM 应用凭据联调） |
| QQ 互联绑定 | ✅ 代码完成（需自备 QQ 应用凭据联调） |
| 找番：关键词 / 标签 / 排序 | ✅ |
| 条目详情 + 章节列表 + 弹幕密度 | ✅ |
| 弹幕：REST + WebSocket + 本校筛选 | ✅ |
| 评论 / 短评 + 影评 + 本校筛选 | ✅ |
| 我的追番看板（五分组：想看/在看/看过/搁置/抛弃） | ✅ |
| 收藏状态站内可改（并镜像 BGM） | ✅ |
| 弹幕源匹配链 + dandanplay 客户端 | ✅ 代码完成（需申请 AppId/AppSecret） |
| 抓取源（web-selector / RSS）+ 管理界面 | ✅ 实测抓到真实资源 |
| Jellyfin / Emby 连接与匹配 | ✅ 实测连接真实服务器并匹配成功 |
| 播放器 + 弹幕叠加（两时钟分离） | ✅ 数据链路已验证，待真实浏览器确认渲染 |
| 外部资源索引（按集分组 + 可播性筛选） | ✅ 实测抓到真实资源并按集正确分组 |
| 正版流媒体源（巴哈姆特动画疯） | ✅ 预设已验证：点开即看，无需下载 |
| 续播（读取 Jellyfin 播放位置） | ✅ |
| 单集进度标记（本地 + BGM 回写） | ✅ |
| 新番时间表（可前后翻周） | ✅ |
| 播放器与片源 | ⏳ 未做（明确不含片源托管） |
| 弹幕敏感词 / 举报审核队列 | ⏳ 未做，**上线前必须补** |

未完成项与上线前必办事项见 [`docs/PLAN.md`](docs/PLAN.md) §8。

## 合规提示

- 本项目**不托管任何视频内容**，条目与章节元数据来自 Bangumi。
- 弹幕与评论为校内用户生成内容，建议上线前配置敏感词过滤与举报审核队列。
- 请遵守 Bangumi 的 User-Agent 要求与使用条款；校内数据（学号、邮箱）按学校规定处理。
