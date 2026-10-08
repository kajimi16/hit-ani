import type { Metadata, Viewport } from "next";

import SideNav from "@/components/side-nav";
import "./globals.css";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import { getSessionUser } from "@/lib/auth/session";
import { SITE_DESCRIPTION, SITE_NAME, metadataBase } from "@/lib/site";

export const metadata: Metadata = {
  /*
   * `metadataBase` 是 OpenGraph 图片地址的基础，**必须设**。
   * 不设时 Next 只给出相对路径，而分享卡片的爬虫在**对方**站点上解析不出
   * 相对路径 —— 结果就是「配了 openGraph 却依然没有预览图」。
   * 取值复用 `APP_BASE_URL`（见 `src/lib/site.ts`），不在这里另读环境变量。
   */
  metadataBase: metadataBase(),
  title: {
    default: `${SITE_NAME} · 校内动漫平台`,
    // 子页面只给自己的标题，避免每个页面都重复整套后缀
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  /*
   * 分享到班群时展开的卡片。`siteName` 与 `title` 分开写：标题是「这部番叫什么」，
   * 站点名是「这是哪个站」—— 混在一起的话长标题会把站点名挤掉。
   */
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    locale: "zh_CN",
  },
  twitter: {
    // 没有大图时 `summary` 会渲染成紧凑的一行，比空着 `summary_large_image` 好看
    card: "summary",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  /*
   * 「添加到主屏幕」用。图标复用 `src/app/icon.svg`（Next 按约定自动注入
   * `<link rel="icon">`），这里只声明它是可安装应用。
   */
  manifest: "/manifest.webmanifest",
};

/** 深色主题是固定的（见 `src/lib/theme.ts`），让浏览器 UI 也跟着变暗。 */
export const viewport: Viewport = {
  themeColor: "#121212",
  colorScheme: "dark",
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
                ? {
                    nickname: user.nickname,
                    schoolId: user.schoolId,
                    isAdmin: user.isAdmin,
                    avatarUrl: user.avatarUrl,
                  }
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
