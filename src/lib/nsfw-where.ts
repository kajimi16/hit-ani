/**
 * 「排除 R18 条目」在 Prisma 查询里的两种形状。
 *
 * 为什么单独一份：收藏/短评直接挂在 `subject` 上，而弹幕/进度要经由
 * `episode.subject` —— 两个形状在追番与时光机里一共要用五处。各写一遍的话，
 * 迟早会有一处写成 `{ nsfw: false }`（顶层，静默不生效）或漏掉 `episode`。
 *
 * 抽出来还有一个实际好处：**规则能被直接断言**。这类过滤漏掉时不会报错，
 * 只会让内容悄悄重新出现 —— 与 `shouldHidePrivate` 属于同一类风险。
 */

/** 顶层对象带 `subject` 关系时用（收藏、短评）。 */
export function hideNsfwBySubject(hide: boolean | undefined) {
  return hide ? { subject: { nsfw: false } } : {};
}

/** 顶层对象带 `episode` 关系时用（弹幕、观看进度）。 */
export function hideNsfwByEpisode(hide: boolean | undefined) {
  return hide ? { episode: { subject: { nsfw: false } } } : {};
}
