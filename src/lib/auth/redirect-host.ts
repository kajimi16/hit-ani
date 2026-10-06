/**
 * OAuth 回调地址与当前访问地址的一致性检查。
 *
 * ## 为什么需要它
 *
 * 授权流程里的 state Cookie 是 **host-only** —— 浏览器只把它发给签发它的
 * **主机名**。若回调落在**另一个主机名**上，Cookie 带不过去，校验必然失败：
 *
 *     授权状态校验失败（state 不匹配或已过期）
 *
 * 那个提示把原因归到「停留太久 / Cookie 没保留」，**完全没说中**，
 * 而用户已经白跑了一趟 bgm.tv。
 *
 * ## 只比主机名，不比端口（这一版是被实测纠正的）
 *
 * 上一版比较的是 `host:port`，那是**错的**：Cookie 的作用域按 RFC 6265
 * 只看主机名，**端口不参与匹配**。实测确认：
 *
 *     在 localhost:3100 设置的 Cookie，访问 localhost:3210 时照样发送
 *
 * 所以「同一主机名不同端口」是**能正常工作**的配置，拿它去拦会误伤 ——
 * 而误拦比不拦更糟（本来能用的流程变成永远被拒）。
 * 真正会让 Cookie 丢失的是**主机名不同**。
 *
 * ## 为什么这个项目特别容易踩
 *
 * 平台用**局域网 IP** 访问，而 `BGM_REDIRECT_URI` 必须在 bgm.tv 上登记成
 * 固定值（BGM 要求逐字符一致）—— 两者天然容易错配。更麻烦的是局域网 IP
 * 会变（本项目实测变过一次：`10.249.61.10` → `192.168.6.203`），登记值随即失效。
 *
 * 因此把检查放在**跳转之前**，当场说清「你从 A 访问，回调登记的是 B」。
 */

import { hostnameOf } from "@/lib/auth/request-origin";

export type RedirectHostVerdict =
  | { ok: true }
  | {
      ok: false;
      /** 浏览器当前访问的地址（含端口，便于用户辨认）。 */
      browsing: string;
      /** `BGM_REDIRECT_URI` 里登记的地址（含端口）。 */
      registered: string;
      /** 可直接展示给用户的说明。 */
      message: string;
    };

/**
 * 比较「浏览器访问的 host」与「登记的回调 host」。
 *
 * @param browserHostValue 浏览器访问的 host（含端口），来自 `browserHost()`
 * @param redirectUri      登记的完整回调地址
 *
 * 解析不出主机名时**放行**：这是辅助检查，不该因意外输入把功能锁死 ——
 * 真正的一致性最终由 bgm.tv 与浏览器的 Cookie 语义兜底。
 */
export function checkRedirectHost(
  browserHostValue: string | null,
  redirectUri: string,
): RedirectHostVerdict {
  if (!browserHostValue) return { ok: true };

  const browsingName = hostnameOf(browserHostValue);
  const registeredHost = hostnameOf((() => {
    try {
      return new URL(redirectUri).host;
    } catch {
      return "";
    }
  })());
  if (!browsingName || !registeredHost) return { ok: true };

  // 比主机名 —— 端口不参与 Cookie 作用域，实测确认
  if (browsingName === registeredHost) return { ok: true };

  let registeredDisplay = redirectUri;
  try {
    const parsed = new URL(redirectUri);
    registeredDisplay = parsed.host;
  } catch {
    // 保留原字符串
  }

  return {
    ok: false,
    browsing: browserHostValue,
    registered: registeredDisplay,
    message:
      `授权会失败：你现在从 ${browserHostValue} 访问，而回调地址登记的是 ${registeredDisplay}。` +
      `登录状态存在 ${browsingName} 这个主机上，Bangumi 把浏览器送回 ${registeredHost} 时` +
      `带不过去（浏览器只把 Cookie 发给签发它的主机名），于是状态校验必然失败。\n\n` +
      `两种解决办法，选一个：\n` +
      `· 改用 ${registeredDisplay} 访问本站，再发起绑定（最省事）；\n` +
      `· 或把 .env 的 BGM_REDIRECT_URI 改成 ${browserHostValue}，` +
      `并同步更新 bgm.tv 应用里登记的回调地址（两处必须逐字符一致）。`,
  };
}
