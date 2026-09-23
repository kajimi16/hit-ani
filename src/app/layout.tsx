import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "hit-ani · 校内动漫平台",
  description: "找番、追番、看番 —— 基于 Bangumi 数据的校内一站式动漫平台",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await getSessionUser();

  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">
        <header className="border-b border-neutral-800">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="text-base font-semibold tracking-tight">
              hit-ani
            </Link>
            <Link href="/schedule" className="text-neutral-400 hover:text-neutral-100">
              时间表
            </Link>
            <Link href="/" className="text-neutral-400 hover:text-neutral-100">
              找番
            </Link>
            <Link href="/library" className="text-neutral-400 hover:text-neutral-100">
              我的追番
            </Link>
            <Link href="/sources" className="text-neutral-400 hover:text-neutral-100">
              媒体源
            </Link>
            <div className="ml-auto flex items-center gap-4">
              {user ? (
                <>
                  <span className="text-neutral-500">
                    {user.nickname}
                    <span className="ml-2 rounded bg-neutral-800 px-2 py-0.5 text-xs">
                      {user.schoolId}
                    </span>
                  </span>
                  <Link href="/settings" className="text-neutral-400 hover:text-neutral-100">
                    设置
                  </Link>
                </>
              ) : (
                <>
                  <Link href="/login" className="text-neutral-400 hover:text-neutral-100">
                    登录
                  </Link>
                  <Link
                    href="/register"
                    className="rounded bg-sky-600 px-3 py-1 text-white hover:bg-sky-500"
                  >
                    注册
                  </Link>
                </>
              )}
            </div>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
