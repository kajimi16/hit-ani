/**
 * 站点元信息 —— 分享预览与 PWA 用。
 *
 * ## 为什么值得做
 *
 * 学生把 `…/subjects/493016` 甩进班群时，预览就是一条**裸链接**（无封面、
 * 无标题、无评分）。对一个靠「同学互相发链接」传播的校内站，这是第一印象。
 *
 * ## `metadataBase` 复用 `APP_BASE_URL`
 *
 * OpenGraph 的图片地址必须是**绝对 URL**（相对路径对方爬虫解析不出）。
 * 而「本站对外地址是什么」已经有一个权威来源：`appBaseUrl()`
 * （`APP_BASE_URL` 环境变量）。在这里再读一遍环境变量就会出现两个来源。
 */

import { appBaseUrl } from "@/lib/auth/request-origin";

/** 站点名。出现在标题后缀与分享卡片上，只此一处。 */
export const SITE_NAME = "hit-ani";

export const SITE_DESCRIPTION = "找番、追番、看番 —— 基于 Bangumi 数据的校内一站式动漫平台";

/**
 * `metadataBase` 需要的绝对地址。
 *
 * 未设 `APP_BASE_URL` 时退回 `http://localhost:3100` —— 这只是为了让 Next
 * 不在构建期报「metadataBase is not set」，**实际分享出去的链接会是错的**。
 * 因此 `docs/DEPLOY.md` 把 `APP_BASE_URL` 列为建议必填。
 */
export function metadataBase(): URL {
  return new URL(appBaseUrl() ?? "http://localhost:3100");
}
