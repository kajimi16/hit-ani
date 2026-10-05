/**
 * 追番页的查询参数解析。
 *
 * 抽成纯函数是为了让「排序 / 视图 / 页码」的合法取值与默认值只有一处定义，
 * 并且能被测试直接钉住 —— 这些值决定了 Prisma 的 `orderBy`，写错不会报错、
 * 只会让列表顺序看起来「没生效」。
 */

/** 排序方式。顺序即界面上从左到右的顺序。 */
export const LIBRARY_SORTS = [
  { value: "recent", label: "最近更新" },
  { value: "collected", label: "加入时间" },
  { value: "myrating", label: "我的评分" },
  { value: "score", label: "Bangumi 评分" },
] as const;

export type LibrarySort = (typeof LIBRARY_SORTS)[number]["value"];

export const LIBRARY_VIEWS = [
  { value: "grid", label: "网格" },
  { value: "list", label: "列表" },
] as const;

export type LibraryView = (typeof LIBRARY_VIEWS)[number]["value"];

/** 聚焦单一状态时的每页条数。 */
export const LIBRARY_PAGE_SIZE = 60;

/**
 * 「全部」视图里每组最多先显示多少条。
 *
 * 这是**卡顿的直接修复**：此前「全部」会把 386 条一次性渲染完，
 * 实测 HTML 达 1.14 MB（386 个 `<img>`），浏览器解析与图片排队都肉眼可见。
 * 现在每组先给这么多，其余走「查看全部 N 部」进聚焦视图。
 */
export const LIBRARY_GROUP_PREVIEW = 12;

export const DEFAULT_LIBRARY_SORT: LibrarySort = "recent";
export const DEFAULT_LIBRARY_VIEW: LibraryView = "grid";

function isSort(value: unknown): value is LibrarySort {
  return typeof value === "string" && LIBRARY_SORTS.some((option) => option.value === value);
}

function isView(value: unknown): value is LibraryView {
  return typeof value === "string" && LIBRARY_VIEWS.some((option) => option.value === value);
}

export interface LibraryQuery {
  sort: LibrarySort;
  view: LibraryView;
  /** 页码，从 1 开始。非法值一律退回 1。 */
  page: number;
}

/**
 * 解析查询参数。**非法值一律退回默认**，不报错 ——
 * 用户手改 URL 或旧书签不该看到 500。
 */
export function parseLibraryQuery(params: {
  sort?: string;
  view?: string;
  page?: string;
}): LibraryQuery {
  const rawPage = Number(params.page ?? 1);
  return {
    sort: isSort(params.sort) ? params.sort : DEFAULT_LIBRARY_SORT,
    view: isView(params.view) ? params.view : DEFAULT_LIBRARY_VIEW,
    page: Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
  };
}

/**
 * 构造同页链接，保留当前的筛选/排序/视图，只覆盖指定的部分。
 *
 * 集中在一处是因为分页、排序、视图切换三种链接都要保留另外两类参数 ——
 * 各自手写 `URLSearchParams` 迟早会漏掉一个，症状是「切换排序后筛选被清空」。
 */
export function libraryHref(current: {
  status?: string;
  sort: LibrarySort;
  view: LibraryView;
  page?: number;
}): string {
  const search = new URLSearchParams();
  if (current.status) search.set("status", current.status);
  // 默认值不写进 URL —— 保持链接干净，也让「未指定」与「显式默认」不可区分
  if (current.sort !== DEFAULT_LIBRARY_SORT) search.set("sort", current.sort);
  if (current.view !== DEFAULT_LIBRARY_VIEW) search.set("view", current.view);
  if (current.page && current.page > 1) search.set("page", String(current.page));
  const qs = search.toString();
  return qs ? `/library?${qs}` : "/library";
}
