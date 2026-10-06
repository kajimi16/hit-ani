"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * 路由级错误边界。
 *
 * ## 为什么必须有
 *
 * 本项目**依赖外部**的地方很多：Bangumi（条目/章节/人物/评论）、Jellyfin、
 * 18 个第三方源。它们失败时，有的路径已经有 `.catch()` 兜底，但**渲染层的
 * 意外**没有 —— 例如上游某个字段的形状变了（`undefined` 上取属性）、
 * 或组件里的一次类型断言失手。
 *
 * 那种情况下 Next 在生产环境显示**裸的错误页**（英文、无导航），
 * 用户只能刷新；而刷新往往并不会好。
 *
 * ## 为什么显示 `digest` 而不是 `error.message`
 *
 * 生产环境下 Next 会把服务端错误的具体信息替换成 `digest` 哈希（避免泄漏
 * 内部细节）。因此这里只展示 `digest` —— 用户拿它来报障，运维能据此在日志里
 * 定位同一条错误。把 `error.message` 直接显示出来在生产上大概率是空的。
 *
 * 开发环境仍然把 `message` 显示出来，便于本地排查。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // 送到服务端日志（`console.error` 在浏览器与 SSR 日志里都能看到）
    console.error("[page-error]", error);
  }, [error]);

  const isDev = process.env.NODE_ENV !== "production";

  return (
    <div className="animate-rise mx-auto max-w-lg space-y-4 py-16 text-center">
      <h1 className="text-2xl font-normal">这一页出错了</h1>
      <p className="text-sm text-on-surface-variant">
        可能是上游（Bangumi / 媒体库 / 抓取源）暂时不可用。可以重试一次，
        或先回探索页。
      </p>

      <div className="flex flex-wrap justify-center gap-3 pt-2">
        {/* `reset()` 会重新渲染这一段路由 —— 比让用户自己刷新更直接 */}
        <button type="button" onClick={reset} className="btn btn-primary">
          重试
        </button>
        <Link href="/" className="btn btn-ghost">
          回到探索
        </Link>
      </div>

      {/*
        报障凭据。`digest` 是生产环境下唯一能把「用户看到的这一屏」与
        「服务端日志里的那条错误」对上的东西 —— 不显示它，用户报障时
        我们只能问「大概是几点」。
      */}
      {(error.digest || isDev) && (
        <p className="pt-4 font-mono text-[0.6875rem] text-on-surface-variant">
          {error.digest && <>错误编号 {error.digest}</>}
          {isDev && error.message && <span className="block">{error.message}</span>}
        </p>
      )}
    </div>
  );
}
