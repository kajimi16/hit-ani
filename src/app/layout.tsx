import type { Metadata } from "next";

import SideNav from "@/components/side-nav";
import "./globals.css";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
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
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/*
          主题引导脚本：必须在首次绘制**之前**跑完，否则会白闪一下。
          见 `src/lib/theme.ts` —— 脚本是内联且无状态的。
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
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
          </div>
        </div>
      </body>
    </html>
  );
}
