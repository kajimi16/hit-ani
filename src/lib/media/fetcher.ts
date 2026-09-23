/**
 * 出站抓取 —— 带 SSRF 防护、逐跳重定向校验、超时与限速。
 *
 * 这是**唯一**会对外发请求的模块；解析逻辑全在 `extract.ts`（纯函数）。
 *
 * 三个必须自己处理、不能交给 `fetch` 默认行为的点：
 *  1. **重定向**：`fetch` 默认自动跟随，但那样就绕过了 URL 校验 ——
 *     攻击者用 `https://evil.com → 302 → http://127.0.0.1:6379` 即可打内网。
 *     因此手动 `redirect: "manual"` 并在每一跳重新校验。
 *  2. **响应体大小**：不设上限时一个超大页面就能吃满内存。
 *  3. **超时**：`fetch` 对响应体没有默认超时，挂起的连接会永久阻塞（本仓库已有前车之鉴）。
 */

import { assertSafeUrl, UnsafeUrlError } from "./url-safety";

/** 单次请求超时。 */
export const FETCH_TIMEOUT_MS = 15_000;
/**
 * 响应体大小上限。
 *
 * 8 MiB 的依据：实测动漫花园的 RSS 搜索每页返回 500 条、约 2 MB，
 * 蜜柑等站点量级相近。设 1 MiB 会把正常订阅直接拒掉（实测踩过）。
 * 再往上则更像是配置写错（例如把整站首页当 RSS 抓），没有放行的理由。
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 5;

/**
 * 默认 User-Agent。
 *
 * ⚠️ 必须是 **ASCII**：HTTP 头按 ByteString 编码，含中文会抛
 * "Cannot convert argument to a ByteString" —— 而且这个错误发生在 fetch 调用时，
 * 看起来像网络问题，实际是请求头构造问题。
 */
export const DEFAULT_USER_AGENT = "hit-ani/0.1 (+https://github.com/hit-ani)";
export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchOptions {
  /** 附加请求头（Referer / Cookie 等，用于防盗链）。 */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 允许的响应 `Content-Type` 前缀；不匹配则拒绝（防把图片当 HTML 解析）。 */
  acceptContentTypes?: string[];
}

export interface FetchResult {
  /** 最终 URL（可能因重定向而变） */
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  /** 经过的重定向链，便于调试 */
  redirects: string[];
}

/** 响应体是否过大 —— 判 `Content-Length` 且实际读取时再兜底一次。 */
function assertSizeAllowed(contentLength: string | null, url: string): void {
  if (contentLength === null) return;
  const size = Number(contentLength);
  if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
    throw new FetchError(
      `响应体过大（${size} 字节，上限 ${MAX_RESPONSE_BYTES}）`,
      url,
    );
  }
}

/**
 * 抓取一个 URL。
 *
 * 每一跳都调用 `assertSafeUrl`，因此 DNS 重绑定与重定向打内网两种攻击都被挡住。
 */
export async function fetchText(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*",
    "Accept-Language": "zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7",
    ...options.headers,
  };

  const redirects: string[] = [];
  let currentUrl = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const safeUrl = await assertSafeUrl(currentUrl);

    const response = await fetch(safeUrl, {
      headers,
      redirect: "manual", // 手动处理，才能逐跳校验
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });

    // 重定向：校验下一跳后再继续
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) {
        throw new FetchError("重定向缺少 Location 头", safeUrl.toString(), response.status);
      }
      const next = new URL(location, safeUrl).toString();
      redirects.push(next);
      currentUrl = next;
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new FetchError(`HTTP ${response.status}`, safeUrl.toString(), response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      options.acceptContentTypes &&
      !options.acceptContentTypes.some((prefix) => contentType.startsWith(prefix))
    ) {
      await response.body?.cancel();
      throw new FetchError(
        `响应类型不符：${contentType || "(空)"}，期望 ${options.acceptContentTypes.join(" / ")}`,
        safeUrl.toString(),
      );
    }

    assertSizeAllowed(response.headers.get("content-length"), safeUrl.toString());

    const body = await readBodyLimited(response, safeUrl.toString());

    return {
      finalUrl: safeUrl.toString(),
      status: response.status,
      contentType,
      body,
      redirects,
    };
  }

  throw new FetchError(`重定向次数超过 ${MAX_REDIRECTS}`, rawUrl);
}

/**
 * 读取响应体，超过上限即中止。
 *
 * 不能只用 `Content-Length` —— 分块传输或伪造头都能绕过，必须在读取过程中也计数。
 */
async function readBodyLimited(response: Response, url: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FetchError(
        `响应体超过上限 ${MAX_RESPONSE_BYTES} 字节，已中止读取`,
        url,
      );
    }
    chunks.push(value);
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

/* ------------------------------------------------------------------ *
 * 限速
 * ------------------------------------------------------------------ */

/**
 * 按 host 记录上次请求时间，保证同一站点的请求间隔不低于配置值。
 *
 * 进程内实现；多实例部署应换 Redis（与弹幕限流同样的替换点）。
 */
const lastRequestAt = new Map<string, number>();

export async function respectRateLimit(
  url: string,
  intervalMs: number,
): Promise<void> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }

  const now = Date.now();
  const previous = lastRequestAt.get(host);
  const waitMs = previous === undefined ? 0 : previous + intervalMs - now;

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastRequestAt.set(host, Date.now());
}

/** 测试用：清空限速记录。 */
export function resetRateLimits(): void {
  lastRequestAt.clear();
}

export { UnsafeUrlError };
