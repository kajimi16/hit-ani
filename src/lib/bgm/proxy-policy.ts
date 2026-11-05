/**
 * BGM 只读代理的路径白名单与响应归一化。
 *
 * 插件在无 VPN 时无法直连 `api.bgm.tv`，由本站代理并落库缓存。
 * 这里只放**纯逻辑**，路由与测试共用：
 * - 白名单（防止代理变成任意 URL 的开放代理）
 * - 路径参数校验（数字 ID）
 * - 缓存 TTL（档期/搜索短，条目/章节长）
 * - 图片 URL 归一化（BGM 周历返回 http，Next Image 只接受 https）
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 路径 → 缓存 TTL；`0` 表示不缓存（搜索是动态结果）。 */
export interface ProxyPolicy {
  upstreamPath: string;
  ttlMs: number;
}

const SUBJECT_RELATIONS: Record<string, true> = {
  characters: true,
  persons: true,
  subjects: true,
};

function isId(value: string | undefined): value is string {
  return value !== undefined && /^[1-9]\d*$/.test(value);
}

/**
 * 解析 `/api/bgm/[...path]` 的路径。
 *
 * 允许：
 * - `GET  calendar`
 * - `GET  v0/episodes?subject_id=`
 * - `GET  v0/subjects/{id}`
 * - `GET  v0/subjects/{id}/{characters|persons|subjects}`
 * - `POST v0/search/subjects`
 *
 * 其余一律 404 —— 尤其是 `v0/me`、收藏写接口，绝不能经由公共代理转发。
 */
export function resolveProxyPolicy(path: string[], method: string): ProxyPolicy | null {
  if (path.length === 0 || path.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }

  if (path.length === 1 && path[0] === "calendar" && method === "GET") {
    return { upstreamPath: "/calendar", ttlMs: DAY_MS / 4 };
  }

  if (path.length === 2 && path[0] === "v0" && path[1] === "episodes" && method === "GET") {
    return { upstreamPath: "/v0/episodes", ttlMs: DAY_MS };
  }

  if (path.length === 3 && path[0] === "v0" && path[1] === "search" && path[2] === "subjects" && method === "POST") {
    return { upstreamPath: "/v0/search/subjects", ttlMs: 0 };
  }

  if (path.length >= 3 && path[0] === "v0" && path[1] === "subjects" && isId(path[2]) && method === "GET") {
    if (path.length === 3) {
      return { upstreamPath: `/v0/subjects/${path[2]}`, ttlMs: DAY_MS };
    }
    if (path.length === 4 && path[3] in SUBJECT_RELATIONS) {
      return { upstreamPath: `/v0/subjects/${path[2]}/${path[3]}`, ttlMs: DAY_MS };
    }
  }

  return null;
}

/** 缓存键：路径 + 排序后的查询串（同一路径不同筛选不能串）。 */
export function proxyCacheKey(path: string[], searchParams: URLSearchParams): string {
  const entries = [...searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = new URLSearchParams(entries).toString();
  return query ? `${path.join("/")}?${query}` : path.join("/");
}

/**
 * 把 BGM 返回的 `http://lain.bgm.tv/...` 全量升级为 https。
 *
 * 递归处理数组/对象；只改图片域名，其他字符串原样保留。
 */
export function normalizeBgmImageUrls<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(/^http:\/\/lain\.bgm\.tv\//i, "https://lain.bgm.tv/")
      .replace(/^http:\/\/bgm\.tv\//i, "https://bgm.tv/") as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeBgmImageUrls(item)) as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = normalizeBgmImageUrls(item);
    }
    return result as T;
  }
  return value;
}
