/**
 * Bangumi 站内评论的抓取与缓存。
 *
 * ## 为什么抓 HTML 而不是调 API
 *
 * Bangumi v0 **没有评论端点**（46 个 `/v0/*` 路径逐个核对过）。但网页版
 * `https://bgm.tv/subject/{id}/comments` 是服务端渲染的完整 HTML，带 20 条
 * 评论与总页数 —— 这是唯一能拿到它们的途径。
 *
 * ## 复用了源抓取的基础设施
 *
 * `fetchText` 已经做了**逐跳重定向校验**，`assertSafeUrl` 做了 SSRF 防护
 * （解析 DNS 并检查全部地址）。本站不上公网、但会在服务端抓外部 URL，
 * 因此这两层是必需的 —— 自己再写一个 fetch 就会绕开它们。
 *
 * ## 缓存策略与其他外部内容一致
 *
 * 评论变动很慢（一条评论通常几分钟到几小时才多一条），而 BGM 对**频繁抓取
 * 网页**是敏感的（比 API 更容易触发限流）。因此：
 * - 结果落库缓存（`DanmakuCache` 同款思路，但单独一张表）；
 * - TTL 6 小时；
 * - 抓取失败时**回退到过期缓存**而不是报错（有旧数据比没有好）。
 */

import { prisma } from "@/lib/prisma";
import { fetchText } from "@/lib/media/fetcher";
import { parseComments, type BgmComment, type BgmCommentsPage } from "./comments";

/** 缓存有效期。评论变动很慢，而 BGM 对频繁抓网页敏感。 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** 每次抓几页。第 1 页 20 条已足够右栏展示；要更多由调用方翻页。 */
const DEFAULT_PAGES = 1;

export interface BgmCommentsResult extends BgmCommentsPage {
  /** 是否来自缓存（界面可据此显示「缓存」标记）。 */
  cached: boolean;
  /** 抓取失败时的原因；成功为 null。 */
  error: string | null;
}

/**
 * 取某条目的 BGM 评论。
 *
 * `force` 为真时跳过缓存（「刷新」按钮用）。
 */
export async function getBgmComments(
  subjectId: number,
  options: { pages?: number; force?: boolean } = {},
): Promise<BgmCommentsResult> {
  const pages = Math.max(1, Math.min(options.pages ?? DEFAULT_PAGES, 5));

  if (!options.force) {
    const cached = await readCache(subjectId);
    if (cached) return cached;
  }

  try {
    const results = await Promise.all(
      Array.from({ length: pages }, (_, index) => fetchCommentPage(subjectId, index + 1)),
    );

    const comments = results.flatMap((page) => page.comments);
    // 总页数以第一页为准（只有首页的翻页链接覆盖全部分页）
    const totalPages = results[0]?.totalPages ?? 1;

    await writeCache(subjectId, comments, totalPages);
    return { comments, totalPages, cached: false, error: null };
  } catch (error) {
    /*
     * 抓取失败时回退到**过期缓存**。
     *
     * 比「直接报错」好得多：评论内容本身几乎不变，一份 8 小时前的列表
     * 与现在几乎一致；而空白页面则什么信息都没有。
     */
    const stale = await readCache(subjectId, { allowStale: true });
    if (stale) return { ...stale, error: describeError(error) };

    return {
      comments: [],
      totalPages: 1,
      cached: false,
      error: describeError(error),
    };
  }
}

async function fetchCommentPage(subjectId: number, page: number): Promise<BgmCommentsPage> {
  // 第一页不带 `page` 参数，避免多一次重定向
  const url =
    page === 1
      ? `https://bgm.tv/subject/${subjectId}/comments`
      : `https://bgm.tv/subject/${subjectId}/comments?page=${page}`;

  const { body } = await fetchText(url, {
    // BGM 网页版对默认 UA 有基本校验，用一个普通的浏览器 UA
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      Referer: `https://bgm.tv/subject/${subjectId}`,
    },
    timeoutMs: 15_000,
  });

  return parseComments(body);
}

/* ------------------------------------------------------------------ *
 * 缓存
 * ------------------------------------------------------------------ */

/**
 * 读缓存。
 *
 * `allowStale` 为真时忽略 TTL（抓取失败的回退路径用）；否则过期即视为未命中。
 */
async function readCache(
  subjectId: number,
  options: { allowStale?: boolean } = {},
): Promise<BgmCommentsResult | null> {
  try {
    const row = await prisma.bgmCommentsCache.findUnique({ where: { subjectId } });
    if (!row) return null;

    const fresh = Date.now() - row.fetchedAt.getTime() < CACHE_TTL_MS;
    if (!fresh && !options.allowStale) return null;

    return {
      comments: JSON.parse(row.payload) as BgmComment[],
      totalPages: row.totalPages,
      cached: true,
      error: null,
    };
  } catch {
    // 缓存读不出来不该阻断功能 —— 走回源
    return null;
  }
}

async function writeCache(
  subjectId: number,
  comments: BgmComment[],
  totalPages: number,
): Promise<void> {
  try {
    const payload = JSON.stringify(comments);
    await prisma.bgmCommentsCache.upsert({
      where: { subjectId },
      create: { subjectId, payload, totalPages, fetchedAt: new Date() },
      update: { payload, totalPages, fetchedAt: new Date() },
    });
  } catch {
    // 写缓存失败不影响本次结果
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("HTTP 404")) return "Bangumi 上没有这个条目";
  if (message.includes("timeout") || message.includes("Timeout")) return "请求 Bangumi 超时";
  return `读取 Bangumi 评论失败：${message}`;
}
