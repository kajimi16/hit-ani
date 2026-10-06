/**
 * 解析**浏览器侧**的 origin。
 *
 * ## 为什么不能用 `new URL(request.url).origin`
 *
 * 实测（本项目、Next 15、真实容器）：`request.url` 的 host 是**服务器自己的
 * 监听地址**，完全无视 `Host` 头：
 *
 *     Host: 192.168.6.203:3100  →  request.url.origin = http://localhost:3100
 *     Host: example.test:1234   →  request.url.origin = http://localhost:3100
 *
 * 后果有三处，都是用户可见的：
 *
 * 1. **重定向把用户送到 localhost** —— 所有 `new URL(path, url.origin)` 拼出的
 *    `Location` 都指向 `localhost:3100`，那是**用户自己那台机器**。
 *    BGM / QQ 回调完成后就会这样（而这正是「授权会报错」的成因之一）。
 * 2. **OAuth 的 `redirect_uri` 推导错**（未显式配置 `BGM_REDIRECT_URI` 时）。
 * 3. **host 一致性检查误判**（见 `redirect-host.ts`）。
 *
 * 因此要用请求头里的 host —— 那才是浏览器实际访问的地址。
 *
 * ## 与既有的「服务端地址 vs 浏览器地址」是同一类坑
 *
 * 本项目此前在 Jellyfin 填 `localhost` 与 WebSocket 地址写死 `localhost`
 * 上各踩过一次。这是第三次，因此集中到一处并写清为什么。
 */

/** 只看这几个头，便于纯函数测试。 */
export interface HostHeaders {
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
}

/** 从 `Headers` 取出本模块关心的三项。 */
export function hostHeadersFrom(headers: Headers): HostHeaders {
  return {
    host: headers.get("host"),
    forwardedHost: headers.get("x-forwarded-host"),
    forwardedProto: headers.get("x-forwarded-proto"),
  };
}

/**
 * 取浏览器访问的 host（含端口）。
 *
 * - 多跳代理时 `x-forwarded-host` 是逗号分隔的列表，**取第一跳**（最靠近
 *   客户端的那一跳就是浏览器实际访问的地址）；
 * - 值里出现空格或斜杠说明不是合法 host（可能是构造的恶意头），丢弃；
 * - 两个头都没有时返回 `null`，调用方退回原有行为 —— 这个函数是**改进**，
 *   不该在缺少头时把功能弄坏。
 */
export function browserHost(h: HostHeaders): string | null {
  for (const raw of [h.forwardedHost, h.host]) {
    if (!raw) continue;
    const first = raw.split(",")[0]!.trim();
    if (!isHostShaped(first)) continue;
    return first.toLowerCase();
  }
  return null;
}

/**
 * 取浏览器访问的 origin（含协议）。
 *
 * 协议优先用 `x-forwarded-proto`（反代终止 TLS 时真实协议在那里），
 * 否则退回 `http` —— 本项目主力部署就是明文 HTTP。
 */
export function browserOrigin(h: HostHeaders): string | null {
  const host = browserHost(h);
  if (!host) return null;
  const proto = h.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

/**
 * host 的**主机名**部分（去掉端口）。
 *
 * Cookie 的作用域按 RFC 6265 只看主机名、**不看端口** —— 实测确认：
 * 在 `localhost:3100` 设置的 Cookie 会被发到 `localhost:3210`。
 * 因此判断「两个地址是否共享 Cookie」时不能比端口。
 */
export function hostnameOf(host: string): string | null {
  /*
   * 先做形状校验，别直接丢给 `new URL`。
   *
   * `new URL("http://a/b")` 会"成功"解析出 hostname `a` —— 斜杠被当成路径。
   * 也就是说 `a/b` 这种明显不是 host 的输入会被当成合法主机名，
   * 于是比较结果毫无意义（甚至误判为「不匹配」而拦下用户）。
   *
   * 合法 host 里不该出现斜杠、反斜杠、空白与 `@`。有了这道校验，
   * 本函数就不依赖调用方先过滤 —— 纵深防御。
   */
  if (!isHostShaped(host)) return null;
  try {
    // 借 URL 解析以正确处理 IPv6（`[::1]:3100`）
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * host 的**形状**校验。合法 host 只由主机名与可选端口组成。
 *
 * 出现斜杠 / 反斜杠 / 空白 / `@` 时一定不是 host：
 * - 斜杠会被 `new URL("http://a/b")` 当成路径，解析出 hostname `a` ——
 *   于是一个明显非法的输入被当成合法主机名（实测踩到）；
 * - `@` 是 userinfo 分隔符，Host 头里不允许出现（RFC 7230 只允许 authority）。
 *
 * 两个函数共用这一条判定，避免只在其中一处加校验导致不一致。
 */
function isHostShaped(value: string): boolean {
  return value.length > 0 && !/[\s/\\@]/.test(value);
}
