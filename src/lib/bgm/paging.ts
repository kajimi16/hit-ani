/**
 * BGM 搜索接口的分页算术。
 *
 * ## 为什么单独成模块
 *
 * 这里的错**不会报错**，只会让内容悄悄不对：请求 24 条、上游只给 20 条，
 * 而 offset 仍按 24 递增 —— 于是每翻一页跳过 4 条，页与页之间既不连续也
 * 不重复任何报错。首页「下一页」曾经因此完全无效（第 2 页与第 1 页逐字相同）。
 * 抽成纯函数是为了让这类错误能被测试直接钉住。
 */

/**
 * 上游单次最多返回的条数。
 *
 * BGM 的 OpenAPI 规范只写「分页参数」，**没有声明上限**；实测请求
 * 21 / 22 / 24 / 25 / 26 / 30 一律只返回 20 条。因此这个值只能靠实测确定，
 * 不能从规范推。若哪天上游放宽，这里要同步更新，否则仍会跳条目。
 */
export const BGM_MAX_PAGE_SIZE = 20;

/**
 * 第 `page` 页（从 1 开始）在结果集中的偏移。
 *
 * `heroCount` 是页面顶部已经单独展示掉的条目数（首页 Hero 轮播占前 N 条）。
 * 搜索模式下没有 Hero，传 0。
 *
 * 偏移按**每页固定步长**递增，而不是按「上次实际收到几条」——
 * 后者会在上游少给一条时把后续全部错位。
 */
export function pageOffset(page: number, heroCount = 0): number {
  const safePage = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  return heroCount + (safePage - 1) * BGM_MAX_PAGE_SIZE;
}

/**
 * 总页数。
 *
 * 必须从总数里减掉 `heroCount` —— 那几条已经被 Hero 拿走了，
 * 否则最后一页会指向一个越界的偏移。至少返回 1，避免页面上出现「第 1 / 0 页」。
 */
export function pageCount(total: number, heroCount = 0): number {
  const available = Math.max(0, total - heroCount);
  return Math.max(1, Math.ceil(available / BGM_MAX_PAGE_SIZE));
}
