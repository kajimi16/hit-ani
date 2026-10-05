import type { Metadata } from "next";

import SideNav from "@/components/side-nav";
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
      <body>
        {/*
          Animeko 桌面端的骨架：左侧 NavigationRail + 右侧内容区
          （`AniNavigationSuiteLayout`）。窄屏时侧栏自动变成吸底 NavigationBar。
        */}
        <div className="app-shell">
          <SideNav
            isAdmin={user?.isAdmin ?? false}
            user={
              user
                ? { nickname: user.nickname, schoolId: user.schoolId, isAdmin: user.isAdmin }
                : null
            }
          />

          <div className="app-main">
            <main className="page-shell py-6">{children}</main>

            <footer className="page-shell border-t border-outline-variant py-6 text-xs text-on-surface-variant/70" style={{ marginTop: "3rem" }}>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span>hit-ani · 校内动漫平台</span>
                <span className="text-outline">|</span>
                <span>
                  条目与章节数据来自{" "}
                  <a
                    href="https://bangumi.tv"
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-outline underline-offset-2 hover:text-primary"
                  >
                    Bangumi
                  </a>
                </span>
                <span className="text-outline">|</span>
                <span>本站不托管视频内容</span>
              </div>
            </footer>
          </div>
        </div>
      </body>
    </html>
  );
}
