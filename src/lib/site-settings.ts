/**
 * 站点级设置的读写。
 *
 * ## 默认值必须偏保守
 *
 * 每项设置在「库里没有这一行」时都要有一个明确的默认值，而且这个默认值
 * 应当等于**引入该开关之前的行为** —— 这样升级现有部署不会悄悄改变现状。
 * 例如 NSFW 开关的默认是「允许用户自己选择」，与加开关之前完全一致；
 * 管理员显式关掉才收紧，而不是升级后突然全网禁掉。
 *
 * ## 值都是字符串，因此解析必须集中在这里
 *
 * `SiteSetting.value` 是 `String`。如果让调用方自己写 `Boolean(row.value)`，
 * 存进去的 `"false"` 会被读成 **true** —— 这是这类 KV 表最典型的坑。
 * 所以对外只暴露语义化的读写函数，不把原始字符串交出去。
 */

import { prisma } from "@/lib/prisma";

/** NSFW 内容是否允许在本站显示（管理员级总开关）。 */
export const SITE_NSFW_KEY = "nsfw_enabled";

/**
 * 布尔值的解析：只有明确的 `"false"` 才算关。
 *
 * 反过来说，`"0"` / `"no"` / 空串都**不**算关 —— 写入侧只写 `"true"` / `"false"`，
 * 出现别的值说明数据被外部改动过；此时按「开着」处理更符合默认语义
 * （默认是开），而不是把一个来路不明的值当成关闭。
 */
export function parseSiteBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

/** NSFW 总开关；库里没有该行时为 `true`（与引入开关前一致）。 */
export async function getSiteNsfwEnabled(): Promise<boolean> {
  const row = await prisma.siteSetting.findUnique({
    where: { key: SITE_NSFW_KEY },
    select: { value: true },
  });
  return parseSiteBoolean(row?.value, true);
}

/** 写入 NSFW 总开关。`actorId` 仅用于追溯。 */
export async function setSiteNsfwEnabled(enabled: boolean, actorId: string): Promise<void> {
  const value = enabled ? "true" : "false";
  await prisma.siteSetting.upsert({
    where: { key: SITE_NSFW_KEY },
    create: { key: SITE_NSFW_KEY, value, updatedBy: actorId },
    update: { value, updatedBy: actorId },
  });
}
