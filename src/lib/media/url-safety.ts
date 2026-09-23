/**
 * 出站请求安全校验（SSRF 防护）。
 *
 * 源配置层会按用户/管理员提供的 URL 发起请求。如果不校验，任何人都能借这台服务器
 * 去探测内网（`http://192.168.1.1/`）、读云元数据（`http://169.254.169.254/`）、
 * 或扫本地端口（`http://127.0.0.1:6379/`）。校内平台尤其危险 ——
 * 内网里往往还有教务、图书馆等系统。
 *
 * 策略：
 *  1. 只允许 http/https
 *  2. 拒绝字面量内网 IP
 *  3. **解析 DNS 后逐个检查所有地址** —— 只查字面量会被 `evil.com → 127.0.0.1` 绕过
 *  4. 重定向逐跳校验（见 `fetcher.ts`）
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class UnsafeUrlError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** 判断一个 IP 字面量是否属于内网/保留地址。 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true; // 解析不了就当作不安全
    }
    const [a, b] = parts;

    if (a === 0) return true; // 0.0.0.0/8 「本网络」
    if (a === 10) return true; // 私有
    if (a === 127) return true; // 环回

    if (a === 169 && b === 254) return true; // 链路本地，含 169.254.169.254 云元数据
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有
    if (a === 192 && b === 168) return true; // 私有
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 协议保留
    if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
    if (a >= 224) return true; // 组播 / 保留
    if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试网段
    return false;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();

    if (normalized === "::" || normalized === "::1") return true; // 未指定 / 环回
    if (normalized.startsWith("fe80")) return true; // 链路本地
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // 唯一本地
    if (normalized.startsWith("ff")) return true; // 组播

    // IPv4 映射地址（::ffff:127.0.0.1）—— 提取尾部再判一次
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPrivateAddress(mapped[1]);

    return false;
  }

  return true; // 既不是 v4 也不是 v6 → 不安全
}

/** 协议白名单。`file:` / `gopher:` / `dict:` 等一律拒绝。 */
export function isAllowedProtocol(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * 校验 URL 是否可安全出站。
 *
 * 会解析 DNS 并检查**所有**解析结果 —— 只要有一个落在内网就拒绝，
 * 防止 DNS 轮询（一部分地址公网、一部分内网）绕过。
 *
 * `allowPrivate`：Jellyfin/Emby 这类**用户自有的媒体服务器**常部署在校园网或家庭局域网，
 * 此时内网地址是合法的。放开它是**有意识的取舍**：
 * 风险从「SSRF 探内网」降级为「已登录用户用自己的凭据访问自己指定的地址」——
 * 这与浏览器能做的事等价。协议校验与格式校验仍然保留。
 */
export async function assertSafeUrl(
  rawUrl: string,
  options: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("URL 格式不合法", rawUrl);
  }

  if (!isAllowedProtocol(url)) {
    throw new UnsafeUrlError(`不支持的协议：${url.protocol}（只允许 http/https）`, rawUrl);
  }

  if (options.allowPrivate) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // 去掉 IPv6 方括号

  // 字面量 IP 直接判，无需 DNS
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new UnsafeUrlError(`目标地址属于内网/保留网段：${hostname}`, rawUrl);
    }
    return url;
  }

  // 域名 → 解析所有地址
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new UnsafeUrlError(`域名解析失败：${hostname}`, rawUrl);
  }

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`域名无解析结果：${hostname}`, rawUrl);
  }

  for (const { address } of addresses) {
    if (!isPrivateAddress(address)) continue;

    // 代理环境的 fake-IP：DNS 结果不代表真实目标，放行（需显式开启）。
    // 仅对**解析结果**放宽；字面量 IP 已在上面无条件拦截。
    if (isFakeIpAddress(address) && trustsFakeIp()) continue;

    throw new UnsafeUrlError(
      `域名 ${hostname} 解析到内网地址 ${address}` +
        (isFakeIpAddress(address)
          ? "（这是代理工具的 fake-IP。若确为本地代理环境，可设置 MEDIA_SSRF_TRUST_FAKE_IP=1）"
          : "（可能是 DNS 重绑定攻击）"),
      rawUrl,
    );
  }

  return url;
}

/**
 * 把可能是相对路径的链接解析成绝对 URL。
 *
 * 这是源配置里最常见的 silent bug：站点返回 `href="/play/123"`，
 * 不解析就直接当 URL 用，结果整条链路拿不到数据。
 */
export function resolveUrl(href: string, base: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  // 跳过锚点与 javascript: 伪协议
  if (trimmed.startsWith("#") || trimmed.toLowerCase().startsWith("javascript:")) return null;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/**
 * 已知的 fake-IP 网段。
 *
 * 代理工具（Clash / Surge 等）在 TUN 模式下用自己的假地址应答 DNS，
 * 再把连接透明转发出去。此时 DNS 结果**不代表真实目标地址**，
 * DNS 校验会产生假阳性 —— 表现为「所有源都被拦截」。
 *
 * 只放行这几个特定段，且**仅限 DNS 解析结果**：字面量 IP 永远拦截
 * （没有人有正当理由直接写 `http://198.18.0.1/`）。
 * 这些段本身不可路由，攻击者无法借它触达真实内网服务。
 *
 * 需显式设置 `MEDIA_SSRF_TRUST_FAKE_IP=1` 才生效。生产环境（真实 DNS）
 * 不应开启，否则会削弱对 DNS 重绑定的防护。
 */
const FAKE_IP_PREFIXES = ["198.18.", "198.19.", "fdfe:dcba:9876:"] as const;

export function isFakeIpAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return FAKE_IP_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/** 是否信任 fake-IP（代理环境）。 */
export function trustsFakeIp(): boolean {
  return process.env.MEDIA_SSRF_TRUST_FAKE_IP === "1";
}
