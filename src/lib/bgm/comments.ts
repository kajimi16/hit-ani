/**
 * Bangumi 站内评论（吐槽箱）的解析。
 *
 * ## 为什么是 HTML 解析
 *
 * Bangumi **v0 API 没有评论/评价端点**（逐个核对过全部 46 个 `/v0/*` 路径，
 * 规范里 `comment` 的 21 处命中全是其他 schema 的字段）。但网页版
 * `https://bgm.tv/subject/{id}/comments` 是**服务端渲染的完整 HTML**，
 * 里面带 20 条评论与分页信息 —— 这是唯一能拿到它们的途径。
 *
 * 因此：抓 HTML → cheerio 解析。与「源抓取」用的是同一套基础设施
 * （`fetchText` 的逐跳重定向校验 + `assertSafeUrl` 的 SSRF 防护）。
 *
 * ## 解析逻辑是纯函数
 *
 * `parseComments(html)` 不碰网络，因此可以用真实抓下来的 HTML 做快照测试。
 * 网页结构会变，所以测试里断言的是「字段被正确取出」，而不是精确的 DOM 路径。
 */

import * as cheerio from "cheerio";

export interface BgmComment {
  /** BGM 用户名（用于显示与去重）。 */
  user: string;
  /** 用户 ID（`/user/{id}` 里的数字）；取不到时为 null。 */
  userId: string | null;
  avatarUrl: string | null;
  /** 1–10 分；未打分时为 null。 */
  rating: number | null;
  /** 收藏状态（看过 / 在看 / 想看 …），取不到时为 null。 */
  collectionType: string | null;
  /** 相对时间原文，如 `@ 51m ago`。BGM 给的是相对时间，无法还原绝对时刻。 */
  timeText: string | null;
  text: string;
}

export interface BgmCommentsPage {
  comments: BgmComment[];
  /** 总页数（从分页链接里读）；没有分页信息时为 1。 */
  totalPages: number;
}

/**
 * 解析评论列表页。
 *
 * 结构（实测 `bgm.tv/subject/493016/comments`）：
 *
 * ```html
 * <div class="item clearit" data-item-user="724489">
 *   <a class="avatar"><span style="background-image:url('//lain.bgm.tv/...')"></span></a>
 *   <a href="/user/724489" class="l">canary</a>
 *   <span class="starstop-s"><span class="starlight stars9"></span></span>
 *   <small class="grey"> 看过 </small>
 *   <small class="grey">@ 51m ago</small>
 *   <p class="comment">正文</p>
 * </div>
 * ```
 *
 * `stars{n}` 里的 `n` 就是分数（1–10）。
 */
export function parseComments(html: string): BgmCommentsPage {
  const $ = cheerio.load(html);
  const comments: BgmComment[] = [];

  $("div.item.clearit").each((_, element) => {
    const item = $(element);

    const text = item.find("p.comment").first().text().trim();
    // 没有正文的条目不是有效评论（可能是占位/广告块）
    if (!text) return;

    const userLink = item.find('a[href^="/user/"]').last();
    const user = userLink.text().trim() || "匿名";
    /*
     * 用户 ID 有两种写法，都要认：
     * - 未设置自定义用户名的账号：`href="/user/724489"` → 数字就是 ID；
     * - 设置了用户名的账号：`href="/user/sumeng1234"` → 此时数字 ID 只在
     *   头像 URL 里（`.../user/l/000/72/69/726916.jpg`）。
     *
     * 只认第一种会让一部分评论的 userId 为 null（实测第一条就是），
     * 而 userId 是去重与「同一用户多条」归并的依据。
     */
    const href = userLink.attr("href") ?? "";
    const fromHref = /\/user\/(\d+)/.exec(href)?.[1] ?? null;

    // 头像在 style 的 background-image 里（`//lain.bgm.tv/...`，协议相对）
    const style = item.find("span").attr("style") ?? "";
    const rawAvatar = /background-image:\s*url\('([^']+)'\)/.exec(style)?.[1] ?? null;
    /*
     * 头像路径里也带数字 ID：`.../000/72/69/726916.jpg`。
     * 文件名可能是 `{id}.jpg`，也可能是 `{id}_{自定义后缀}.jpg`（实测两者都有，
     * 例如 `844961_Brimh.jpg`）—— 所以不能要求 `.jpg` 紧跟数字。
     */
    const fromAvatar = rawAvatar ? /\/(\d+)[._]/.exec(rawAvatar)?.[1] ?? null : null;
    const userId = fromHref ?? fromAvatar;
    const avatarUrl = rawAvatar ? (rawAvatar.startsWith("//") ? `https:${rawAvatar}` : rawAvatar) : null;

    const stars = /starlight stars(\d+)/.exec(item.find("span.starlight").attr("class") ?? "");
    const rating = stars ? Number(stars[1]) : null;

    const greys = item.find("small.grey").map((__, el) => $(el).text().trim()).get();
    // 状态词是中文（看过/在看/想看/搁置/抛弃）；时间以 `@` 开头
    const collectionType = greys.find((t) => t && !t.startsWith("@")) ?? null;
    const timeText = greys.find((t) => t.startsWith("@")) ?? null;

    comments.push({
      user,
      userId,
      avatarUrl,
      // 越界的星数当没打分，而不是显示一个 BGM 不会给的值
      rating: rating !== null && rating >= 1 && rating <= 10 ? rating : null,
      collectionType,
      timeText,
      text,
    });
  });

  return { comments, totalPages: parseTotalPages($) };
}

/** 从分页链接里读总页数（`?page=141` 里最大的那个）。 */
function parseTotalPages($: cheerio.CheerioAPI): number {
  let max = 1;
  $('a[href*="page="]').each((_, element) => {
    const match = /[?&]page=(\d+)/.exec($(element).attr("href") ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  });
  return max;
}
