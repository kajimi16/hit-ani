import { NextRequest, NextResponse } from "next/server";
import { BGM_USER_AGENT } from "@/lib/bgm/client";
import {
  forceSearchNsfw,
  normalizeBgmImageUrls,
  proxyCacheKey,
  resolveProxyPolicy,
} from "@/lib/bgm/proxy-policy";
import { withUpstreamCache } from "@/lib/cache/upstream-cache";
import { prisma } from "@/lib/prisma";
import { getSiteNsfwEnabled } from "@/lib/site-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM = "https://api.bgm.tv";
const CACHE_NAMESPACE = "bgm-proxy";

/**
 * BGM 只读缓存代理。
 *
 * 校内用户不挂 VPN 时无法访问 `api.bgm.tv`，由本站代替请求并落库缓存：
 * - 日历 6 小时、条目/章节/角色/制作/关联 24 小时
 * - 上游失败时 `withUpstreamCache` 会回退到陈旧数据（3 天上界）
 * - 图片地址统一升级 https，客户端再走本站 `/_next/image` 缓存
 *
 * 严格白名单，只转发插件需要的只读路径；`v0/me`、收藏写接口不可达。
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const policy = resolveProxyPolicy(path, "GET");
  if (!policy) {
    return NextResponse.json({ error: "不支持的代理路径" }, { status: 404 });
  }

  const searchParams = new URL(request.url).searchParams;
  if (policy.upstreamPath === "/v0/episodes" && !searchParams.get("subject_id")) {
    return NextResponse.json({ error: "缺少 subject_id" }, { status: 400 });
  }

  try {
    const key = proxyCacheKey(path, searchParams);
    const fetcher = () => fetchUpstream(policy.upstreamPath, searchParams, { method: "GET" });
    const data = policy.ttlMs > 0
      ? await withUpstreamCache(
          { namespace: CACHE_NAMESPACE, key, ttlMs: policy.ttlMs },
          fetcher,
        )
      : await fetcher();

    const filtered = await filterNsfw(policy.upstreamPath, normalizeBgmImageUrls(data));
    if (filtered === null) {
      return NextResponse.json({ error: "条目不存在" }, { status: 404 });
    }
    return NextResponse.json(filtered, {
      headers: policy.ttlMs > 0
        ? { "Cache-Control": `public, max-age=${Math.floor(policy.ttlMs / 1000)}` }
        : { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "BGM 代理失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

/** 搜索是动态结果，不缓存；但仍由本站出网。 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const policy = resolveProxyPolicy(path, "POST");
  if (!policy) {
    return NextResponse.json({ error: "不支持的代理路径" }, { status: 404 });
  }

  let body = await request.text();
  if (body.length > 64 * 1024) {
    return NextResponse.json({ error: "请求体过大" }, { status: 413 });
  }

  try {
    // 公开代理不能成为 NSFW 旁路；站点关闭时强制 filter.nsfw=false。
    if (policy.upstreamPath === "/v0/search/subjects") {
      body = forceSearchNsfw(body, await getSiteNsfwEnabled());
    }

    const data = await fetchUpstream(
      policy.upstreamPath,
      new URL(request.url).searchParams,
      { method: "POST", body },
    );
    return NextResponse.json(normalizeBgmImageUrls(data), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "BGM 代理失败",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

async function fetchUpstream(
  path: string,
  searchParams: URLSearchParams,
  init: RequestInit,
): Promise<unknown> {
  const query = searchParams.toString();
  const url = `${UPSTREAM}${path}${query ? `?${query}` : ""}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": BGM_USER_AGENT,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`上游 HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (text.trim() === "") return null;
  return JSON.parse(text);
}

/**
 * NSFW 与站点设置保持一致：
 * - 周历：按本地 `Subject.nsfw` 标记过滤条目
 * - 条目详情：上游或本地标记为 NSFW 且站点关闭时返回 404
 */
async function filterNsfw(upstreamPath: string, data: unknown): Promise<unknown | null> {
  if (await getSiteNsfwEnabled()) return data;

  if (upstreamPath === "/calendar" && Array.isArray(data)) {
    const days = data as { items?: { id?: number }[] }[];
    const ids = days
      .flatMap((day) => day.items ?? [])
      .map((item) => item.id)
      .filter((id): id is number => typeof id === "number" && id > 0);
    if (ids.length === 0) return data;
    const flagged = await prisma.subject.findMany({
      where: { id: { in: ids }, nsfw: true },
      select: { id: true },
    });
    const hidden = new Set(flagged.map((row) => row.id));
    return days.map((day) => ({
      ...day,
      items: (day.items ?? []).filter((item) => !item.id || !hidden.has(item.id)),
    }));
  }

  if (upstreamPath.startsWith("/v0/subjects/") && !upstreamPath.includes("/characters") &&
      !upstreamPath.includes("/persons") && !upstreamPath.includes("/subjects")) {
    const subject = data as { id?: number; nsfw?: boolean } | null;
    if (!subject || typeof subject.id !== "number") return data;
    if (subject.nsfw) return null;
    const local = await prisma.subject.findUnique({
      where: { id: subject.id },
      select: { nsfw: true },
    });
    return local?.nsfw ? null : data;
  }

  return data;
}
