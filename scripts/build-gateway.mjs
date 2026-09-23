/**
 * 把弹幕网关打包成单文件，供生产环境直接 `node dist/danmaku-gateway.js` 运行。
 *
 * 为什么要打包而不是运行时用 tsx：
 * - tsx 是 devDependency，生产镜像里会被 `npm prune --omit=dev` 剔除
 * - 单文件启动更快，也不必在生产镜像里保留 TypeScript 运行时
 *
 * 为什么 `@prisma/client` 与 `ws` 保持 external：
 * @prisma/client 带平台相关的原生查询引擎（按 debian-openssl-3.0.x 分发），
 * 打包进去会破坏它的二进制加载路径。这类"自带 native 资产"的依赖必须 external。
 */

import { build } from "esbuild";

await build({
  entryPoints: ["src/server/danmaku-gateway.ts"],
  outfile: "dist/danmaku-gateway.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",

  // 路径别名与 tsconfig 保持一致（esbuild 不读 tsconfig 的 paths）
  alias: { "@": "./src" },

  // 含原生资产或运行时动态加载的依赖不能打包
  external: ["@prisma/client", ".prisma", "ws"],

  // 生产可读性：保留行号便于定位崩溃，但不注入 sourcemap 文件
  minify: false,
  sourcemap: false,
  logLevel: "info",

  // `require` 在 ESM 输出里由 esbuild 的 shim 提供；Node 22 原生支持
  banner: {
    js: "// hit-ani danmaku gateway — 由 scripts/build-gateway.mjs 打包\n",
  },
});

console.log("✔ dist/danmaku-gateway.js");
