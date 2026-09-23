# hit-ani 生产镜像
#
# 三阶段构建，目的是让**运行时镜像不含构建工具链与 devDependencies**：
#   deps    安装全部依赖（构建需要 typescript / tailwind / prisma CLI）
#   builder 生成 Prisma Client、构建 Next.js、打包弹幕网关
#   runner  只带生产依赖与构建产物，非 root 运行
#
# 基础镜像选 debian-slim（非 alpine）的原因：
# Prisma 的查询引擎按平台分发预编译二进制，本项目的目标是
# `debian-openssl-3.0.x`。Debian 12 自带 glibc 2.36 与 openssl 3.x 与之匹配；
# alpine 用 musl，需要另装兼容层（libc6-compat），反而更脆。

# ---------------------------------------------------------------- deps
FROM node:22-slim AS deps
WORKDIR /app

# Prisma 需要 libssl 才能加载查询引擎 —— 缺了会在**运行时**才报错，很难排查
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------- builder
FROM node:22-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Prisma Client 必须先生成 —— 它决定 `@prisma/client` 的类型与运行时
RUN npx prisma generate

# Next.js 生产构建。构建期会连数据库吗？不会 —— 所有页面都是
# `dynamic = "force-dynamic"`，不做静态预渲染取数。
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# 把弹幕网关打成单文件，避免运行时依赖 tsx
RUN npm run gateway:build

# ---------------------------------------------------------------- prod-deps
#
# 干净安装**生产依赖**，不靠 `npm prune` 裁剪。
#
# 为什么不用 `npm prune --omit=dev`：prune 需要写 node_modules，
# 而它在 runner 阶段以 root 执行时，node_modules 已被 `--chown=nextjs` 改属主，
# 结果是 prune 静默地只删掉一部分 —— 实测把 node_modules 从 345 减到 25 个包，
# `next` 与 `ws` 都被误删，容器启动即 'next: not found'。
# 单独一个阶段做干净安装，行为确定、可复现。
FROM node:22-slim AS prod-deps
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------- migrator
#
# 数据库 schema 同步是一个**一次性任务**，它需要 `prisma` CLI ——
# 而 CLI 是 devDependency，被 runner 阶段的 `npm prune --omit=dev` 剔除了。
# 因此单独留一个带完整依赖的阶段给 migrate 用，避免为了一个 CLI
# 把整个生产镜像撑大（或依赖 npx 临时下载 —— 容器内没有写权限，会直接失败）。
FROM builder AS migrator
CMD ["npx", "prisma", "db", "push", "--skip-generate"]

# ---------------------------------------------------------------- runner
FROM node:22-slim AS runner
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# 非 root 运行。数据库卷与上传目录需要写权限，所以先建好再切用户。
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home nextjs

# 生产依赖来自 prod-deps（干净安装），随后覆盖 Prisma Client ——
# 生成好的 Client 在 builder 阶段产出，prod-deps 里没有。
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/next.config.ts ./next.config.ts

USER nextjs

# 3100 = Next.js（页面 + API）；3102 = 弹幕 WebSocket 网关
EXPOSE 3100 3102

# 健康检查打 /api/health —— 它同时验证进程存活与数据库连通
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3100/api/health || exit 1

# 默认启动 web；compose 里会为网关覆盖 command
CMD ["npm", "run", "start"]
