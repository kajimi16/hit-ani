/**
 * NSFW（R18）内容的显示偏好。
 *
 * ## 为什么存 Cookie 而不是 localStorage
 *
 * 主题偏好存 localStorage 是合适的（它只影响 CSS，引导脚本在首屏前就能应用）。
 * 但**这个偏好必须在服务端可读**：探索页与时间表是服务端组件，它们直接在
 * 服务端调用 `searchSubjects` 决定要请求哪些条目 —— 客户端读不到 localStorage
 * 就意味着要么把取数搬到客户端（大改），要么首屏先按默认值渲染再闪一下换掉。
 *
 * Cookie 两边都能读，且它是**设备级**偏好（宿舍的私人电脑与图书馆的公用机器
 * 显然该用不同设置），不适合放进账号级数据库。
 *
 * ## 默认「不显示」
 *
 * 这是校内平台，默认出现在探索页与时间表上的内容必须对所有人都合适。
 * 想找 R18 的用户可以自己打开；反过来（默认显示、需自己关）会让不知情的
 * 用户直接撞见不该看到的内容。
 *
 * ## 打开 ≠ 一定能看到
 *
 * Bangumi 的 `nsfw: true` 需要账号权限，**无权限的用户会被直接忽略该字段**
 * （规范原文）。因此「显示」的语义是「不再主动过滤」，而不是「保证有 R18
 * 内容」—— 界面上的说明如实反映这一点。
 */

/** Cookie 名。非 httpOnly —— 设置页需要在客户端写入。 */
export const NSFW_COOKIE = "hit-ani-nsfw";

export type NsfwPreference = "hide" | "show";

export const DEFAULT_NSFW_PREFERENCE: NsfwPreference = "hide";

export const NSFW_LABELS: Record<NsfwPreference, string> = {
  hide: "不显示",
  show: "显示",
};

export function isNsfwPreference(value: unknown): value is NsfwPreference {
  return value === "hide" || value === "show";
}

/** 把 cookie 的原始值解析成偏好；非法值退回默认。 */
export function parseNsfwCookie(raw: string | undefined): NsfwPreference {
  return isNsfwPreference(raw) ? raw : DEFAULT_NSFW_PREFERENCE;
}

/**
 * 把偏好翻译成 BGM 搜索的 `nsfw` 过滤值。
 *
 * - `hide` → `false`：只要非 R18 条目（BGM 文档明确支持，无需权限）。
 * - `show` → `undefined`：**整个键都不传**。规范说「默认或 `null` 返回包含
 *   R18 的所有结果」，而传 `true` 需要权限、无权限会被静默忽略 ——
 *   不传是唯一既不依赖权限、又能拿到全部可用结果的写法。
 */
export function nsfwFilterValue(preference: NsfwPreference): false | undefined {
  return preference === "show" ? undefined : false;
}

/** 一年。偏好变动极少，长有效期省掉每次访问的写入。 */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * 客户端写入偏好 cookie。
 *
 * 不用 `SameSite=None`：这个 cookie 只在同站导航时需要，`Lax` 足够，
 * 也避免了必须带 `Secure` 的要求（校内是明文 HTTP 部署）。
 */
export function writeNsfwCookie(value: NsfwPreference): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${NSFW_COOKIE}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
