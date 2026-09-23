/**
 * 弹幕屏蔽词过滤。
 *
 * 两层设计，各司其职：
 *
 * 1. **服务端关键词表**（本模块）：由管理员配置的全局屏蔽词，对所有人生效。
 *    这是「必须挡住」的底线内容 —— 违规内容不能因为用户没设过滤就看到。
 * 2. **客户端本地正则**：用户自己的偏好（不想看剧透、不想看某个梗），
 *    存在 localStorage，即时生效、不走网络。
 *
 * 服务端这一层是上线前的必需项：弹幕是校内 UGC，
 * 没有内容过滤意味着违规内容直接进所有人的屏幕。
 */

/** 环境变量 `DANMAKU_BLOCKED_WORDS`，逗号分隔。 */
export function blockedWords(): string[] {
  const raw = process.env.DANMAKU_BLOCKED_WORDS ?? "";
  return raw
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

/**
 * 文本是否命中屏蔽词。
 *
 * 匹配策略：大小写不敏感 + 子串匹配。
 *
 * 为什么用子串而非整词：中文没有词边界，`\b` 在中文上不生效；
 * 而屏蔽词场景下「宁可多挡」比「漏挡」安全 —— 误挡一条可以申诉，漏挡违规内容不可逆。
 * 屏蔽词表应由管理员按校内实际情况维护，而非硬编码。
 */
export function isBlocked(text: string, words: readonly string[] = blockedWords()): boolean {
  if (words.length === 0) return false;
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

/** 屏蔽词数量为 0 时给出部署提醒（不阻断功能，只是提示）。 */
export function hasBlocklist(): boolean {
  return blockedWords().length > 0;
}
