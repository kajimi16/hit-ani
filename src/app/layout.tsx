import type { Metadata } from "next";
import Link from "next/link";
import NavLinks from "@/components/nav-links";
import UserMenu from "@/components/user-menu";
import "./globals.css";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: {
    default: "hit-ani · 校内动漫平台",
    // 子页面只给自己的标题，避免每个页面都重复整套后缀
    template: "%s · hit-ani",
  },
  description: "找番、追番、看番 —— 基于 Bangumi 数据的校内一站式动漫平台",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getSessionUser();

  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col">
        {/*
          导航吸顶：列表页往下滚时仍能切换板块。
          backdrop-blur 让内容从下方滚过时不完全遮挡，视觉上更轻。
        */}
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-md">
          <nav className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4">
            <Link
              href="/"
              className="mr-4 flex items-center gap-2 text-base font-semibold tracking-tight text-ink"
            >
              {/*
                用一个色块作为标识 —— 纯文字 logo 在深色导航里没有记忆点。
                做成渐变方块而非图片：不引入资源请求，且跟随主题色。
              */}
              <span
                aria-hidden
                className="size-6 rounded-md bg-gradient-to-br from-accent to-accent-strong"
              />
              hit-ani
            </Link>

            {/* 导航项需要高亮当前页，因此是客户端组件（用 usePathname） */}
            <NavLinks isAdmin={user?.isAdmin ?? false} />

            <div className="ml-auto flex items-center gap-3">
              {user ? (
                <>
                  <Link
                    href="/settings"
                    className="rounded-md px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    设置
                  </Link>
                  <UserMenu
                    nickname={user.nickname}
                    schoolId={user.schoolId}
                    isAdmin={user.isAdmin}
                  />
                </>
              ) : (
                <>
                  <Link
                    href="/login"
                    className="rounded-md px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    登录
                  </Link>
                  <Link href="/register" className="btn btn-primary btn-sm">
                    注册
                  </Link>
                </>
              )}
            </div>
          </nav>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">{children}</main>

        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-6 text-xs text-ink-faint">
            <span>hit-ani · 校内动漫平台</span>
            <span className="text-line-strong">|</span>
            <span>
              条目与章节数据来自{" "}
              <a
                href="https://bangumi.tv"
                target="_blank"
                rel="noreferrer"
                className="text-ink-muted underline decoration-line-strong underline-offset-2 hover:text-accent"
              >
                Bangumi
              </a>
            </span>
            <span className="text-line-strong">|</span>
            <span>本站不托管视频内容</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
