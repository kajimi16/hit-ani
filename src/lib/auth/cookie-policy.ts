/**
 * Cookie 的 `Secure` 标志判定。
 *
 * ## 为什么不能用 `NODE_ENV` 推断
 *
 * 原先写的是 `secure: process.env.NODE_ENV === "production"` —— 容器里
 * `NODE_ENV=production`，于是会话 Cookie 带上 `Secure`。而**浏览器拒绝在
 * 明文 HTTP 的非可信源上存储 Secure Cookie**（`localhost` 被当作可信源豁免）。
 *
 * 结果：从局域网 IP 访问时，登录接口返回 200、响应头也正常，
 * 但浏览器**静默丢弃** Cookie → 后续请求仍是未登录。
 *
 * 这个 bug 躲过了全部自动化验证，因为**所有测试都走 `localhost`** ——
 * 恰好命中豁免。与 Jellyfin 填 `localhost`、WS 地址写死 `localhost` 是同一类
 * 「环境假设」缺陷：在开发机上永远是对的。
 *
 * ## 现在的判定
 *
 * 用**真实连接协议**而非构建环境：
 *
 * 1. 显式覆盖 `SESSION_COOKIE_SECURE=1|0`（运维需要强制时用）
 * 2. 否则看 `x-forwarded-proto`（反向代理置的）—— `https` 才加 `Secure`
 * 3. 都没有（直连 HTTP）→ 不加
 *
 * 这样：直连 HTTP 能登录；反代 TLS 自动获得 `Secure`；本地开发也不受影响。
 */

/** 是否显式指定了策略。只认 `1`/`0`，避免 `false` 这类误配造成意外行为。 */
export function secureCookieOverride(
  raw = process.env.SESSION_COOKIE_SECURE,
): boolean | null {
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export interface SecureCookieInput {
  /** 反向代理置的 `x-forwarded-proto`（可能缺失） */
  forwardedProto?: string | null;
  /** 显式覆盖值；不传则读环境变量 */
  override?: boolean | null;
}

/**
 * 判定是否给 Cookie 加 `Secure`。
 *
 * `x-forwarded-proto` 的信任边界：它可被客户端伪造，但**只影响其自身请求**的
 * `Secure` 标志 —— 攻击者让自己的 Cookie 不带 Secure 并不能攻击他人。
 * 因此这里信任它是安全的（这与信任它做鉴权判定有本质区别）。
 */
export function shouldUseSecureCookie(input: SecureCookieInput = {}): boolean {
  const override =
    input.override === undefined ? secureCookieOverride() : input.override;
  if (override !== null) return override;

  // 反代可能给出逗号分隔的链（`https, http`）—— 取第一跳
  const proto = input.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return proto === "https";
}

/**
 * 从 Next.js 的 `headers()` 读协议并判定。
 *
 * 放在这里而不是各处自己读，是为了让三个写 Cookie 的地方
 * （会话、BGM state、QQ state）用同一套判定 —— 原先它们复制了同一段
 * `NODE_ENV` 逻辑，因此会一起出错。
 */
export function resolveSecureCookie(headerList: {
  get(name: string): string | null;
}): boolean {
  return shouldUseSecureCookie({
    forwardedProto: headerList.get("x-forwarded-proto"),
  });
}
