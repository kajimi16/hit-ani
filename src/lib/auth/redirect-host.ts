/**
 * OAuth 回调地址与当前访问 host 的一致性检查。
 *
 * ## 为什么需要它
 *
 * 授权流程里有**两个 host** 必须一致：
 *
 * 1. 用户浏览器访问本平台的 host（决定 state Cookie 存在哪个 host 上）；
 * 2. `BGM_REDIRECT_URI` 的 host（决定 bgm.tv 把用户送回哪里）。
 *
 * state Cookie 是 **host-only**（没有 `Domain` 属性）—— 浏览器**只**把它发给
 * 签发它的那个 host。所以 1 与 2 不一致时，回调请求里不带 state Cookie，
 * 校验必然失败，用户看到的是：
 *
 *     授权状态校验失败（state 不匹配或已过期）
 *
 * 这个提示把原因指向「停留太久 / Cookie 没保留」，**完全没说中真正的原因**，
 * 而用户已经白跑了一趟 bgm.tv。
 *
 * ## 为什么这个项目特别容易踩
 *
 * 平台是校内自建、用**局域网 IP** 访问，而 `BGM_REDIRECT_URI` 又必须在
 * bgm.tv 上登记成固定值（BGM 要求逐字符一致）。于是常见的错配是：
 *
 * - 在 `192.168.6.203:3100` 打开，却把回调登记成 `localhost:3100`；
 * - 本机调试用 localhost，实际使用走 IP。
 *
 * 更麻烦的是**局域网 IP 会变**（换网络、DHCP 续租）—— 本项目实测变过一次
 * （`10.249.61.10` → `192.168.6.203`），登记值随即失效。
 *
 * 因此把检查放在**跳转之前**：与其让用户去 bgm.tv 绕一圈再回来撞一个含糊的
 * 错误，不如当场说清「你从 A 访问，回调却登记成 B」。
 */

export type RedirectHostVerdict =
  | { ok: true }
  | {
      ok: false;
      /** 浏览器当前访问的 host（含端口）。 */
      browsing: string;
      /** `BGM_REDIRECT_URI` 里的 host（含端口）。 */
      registered: string;
      /** 可直接展示给用户的说明。 */
      message: string;
    };

/**
 * 取出 URL 的 host（含端口，小写）。
 *
 * 解析失败返回 `null` —— 调用方据此放行，见 `checkRedirectHost` 的说明。
 */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 比较「当前访问 host」与「登记的回调 host」。
 *
 * **比 host 而不是 origin**：协议差异不影响 host-only Cookie 的匹配
 * （http 与 https 共用同一个 host 的 Cookie 域），而本项目在明文 HTTP 上跑、
 * `BGM_REDIRECT_URI` 可能被登记成 https。只要 host+port 一致，Cookie 就能带过去。
 *
 * 解析不出 host 时**放行**：这个检查是辅助性的，不该因为意外输入把功能锁死 ——
 * 真正的一致性最终由 bgm.tv 与浏览器 Cookie 语义兜底。
 */
export function checkRedirectHost(currentOrigin: string, redirectUri: string): RedirectHostVerdict {
  const browsing = hostOf(currentOrigin);
  const registered = hostOf(redirectUri);
  if (!browsing || !registered) return { ok: true };
  if (browsing === registered) return { ok: true };

  return {
    ok: false,
    browsing,
    registered,
    message:
      `授权会失败：你现在从 ${browsing} 访问，而回调地址登记的是 ${registered}。` +
      `登录状态存在 ${browsing} 这个地址上，Bangumi 把浏览器送回 ${registered} 时` +
      `带不过去（浏览器只把 Cookie 发给签发它的地址），于是状态校验必然失败。\n\n` +
      `两种解决办法，选一个：\n` +
      `· 改用 ${registered} 访问本站，再发起绑定（最省事）；\n` +
      `· 或把 .env 的 BGM_REDIRECT_URI 改成 ${browsing}，` +
      `并同步更新 bgm.tv 应用里登记的回调地址（两处必须逐字符一致）。`,
  };
}
