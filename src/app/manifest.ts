import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

/**
 * PWA manifest —— 让同学能把站点「添加到主屏幕」，打开时没有浏览器地址栏。
 *
 * 图标复用 `src/app/icon.svg`（Next 的约定文件，已自动注入 `<link rel="icon">`）。
 * 这里不重复声明 `icons`：两处各写一份尺寸清单，迟早只有一处被更新。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} · 校内动漫平台`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    // 主题写死深色：本站不支持亮色主题，声明成 "auto" 会让系统亮色下边框变白。
    background_color: "#121212",
    theme_color: "#121212",
    lang: "zh-CN",
  };
}
