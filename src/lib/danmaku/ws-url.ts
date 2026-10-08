"use client";

/**
 * 弹幕网关的 WebSocket 地址。
 *
 * ## 为什么不写死 localhost
 *
 * `NEXT_PUBLIC_*` 是**构建期**烘焙进浏览器包的常量。若把它设成
 * `ws://localhost:3102`，学生从自己电脑打开页面时，浏览器会把 `localhost`
 * 解析成**他自己的机器** —— 连接必然失败，而且只有服务器上访问的人能用。
 *
 * 这与 Jellyfin 那边「填 localhost 会导致除服务器本人外都播不了」是同一类错误，
 * 在 Web 里尤其隐蔽：服务器上测一切正常。
 *
 * ## 策略（三种形态都要能工作）
 *
 * 1. **同源路径**：`/danmaku-ws` → `wss://<当前页面的 host>/danmaku-ws`。
 *    用域名 + 反向代理时必须用这个 —— 端口与证书都由那个代理负责，
 *    不必单独暴露 3102，也不必为它再签一张证书。
 * 2. **绝对地址**：`wss://…` 直接用；写成 `https://…` 会**转成** `wss://`。
 * 3. **不配置**：从页面地址推导主机名，端口取 `NEXT_PUBLIC_DANMAKU_WS_PORT`
 *    （默认 3102）。镜像因此与主机名无关：用 IP 访问连 IP，用域名连域名。
 *
 * ## ⚠️ 这里是**构建期**烘焙的
 *
 * 与 `APP_BASE_URL` 不同：改这两个变量**必须重新构建镜像**，只改 `.env`
 * 不起作用。换域名/上反向代理时最容易被漏掉的一步，漏了的症状是
 * 「页面正常但弹幕一直连不上」。
 *
 * ## 为什么下面要自己做 scheme 转换
 *
 * `new WebSocket()` 只接受 `ws:` / `wss:`，传 `http://…` 或**相对路径**会
 * 直接 `SyntaxError: Invalid URL` —— 而旧实现把配置值原样拼上去，
 * 于是「按文档配了反向代理地址」反而让弹幕整个挂掉，且报错信息与配置无关。
 */

const WS_PORT = process.env.NEXT_PUBLIC_DANMAKU_WS_PORT ?? "3102";

/** 显式配置（构建期）。空/未设置时返回 null 表示「按页面地址推导」。 */
const CONFIGURED = process.env.NEXT_PUBLIC_DANMAKU_WS_URL?.trim() || null;

/** 当前页面的 WS scheme —— 页面是 https 就必须用 wss，否则浏览器会拦。 */
function pageWsScheme(): "ws:" | "wss:" {
  return window.location.protocol === "https:" ? "wss:" : "ws:";
}

/**
 * 把配置值规范化成 `ws:` / `wss:` 绝对地址。
 *
 * 暴露出来是为了**能被测试**：这段是纯字符串处理，而它出错的方式
 * （抛 `Invalid URL`）只有真跑到浏览器里才会暴露。
 */
export function normalizeWsBase(configured: string, origin: { protocol: string; host: string }): string {
  const value = configured.trim();
  if (!value) throw new Error("normalizeWsBase 收到空值");

  // 同源路径：协议与端口都跟随页面（反向代理后面就是 443 + 那张证书）
  if (value.startsWith("/")) {
    const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${origin.host}${value.replace(/\/+$/, "")}`;
  }

  // 已经是 ws/wss：原样用（保留用户的写法，包括大小写）
  if (/^wss?:\/\//i.test(value)) return value.replace(/\/+$/, "");

  // http/https：转成对应的 ws/wss。直接用会让 `new WebSocket` 抛 SyntaxError。
  //
  // 注意**不能**用 `/^http/i → "ws"` 这种替换：`HTTPS://x` 会变成 `wsS://x`
  // （只换了 4 个字符，剩下的 `S` 留着）。按小写判定后整体重建前缀。
  const trimmed = value.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    const isSecure = trimmed.toLowerCase().startsWith("https:");
    const rest = trimmed.slice(trimmed.indexOf("//") + 2);
    return `${isSecure ? "wss:" : "ws:"}//${rest}`;
  }

  // 别的一律当主机名处理（例如只写了 `gateway:3102`）
  const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${value.replace(/\/+$/, "")}`;
}

/**
 * 解析出弹幕网关的 WS 基址（无尾斜杠）。
 *
 * 必须在客户端调用（需要 `window`）。SSR 阶段返回空串 —— 弹幕组件都是
 * `"use client"` 且只在 effect 里连接，不会走到 SSR 分支。
 */
export function danmakuWsBase(): string {
  if (typeof window === "undefined") return "";

  if (CONFIGURED) {
    try {
      return normalizeWsBase(CONFIGURED, {
        protocol: window.location.protocol,
        host: window.location.host,
      });
    } catch {
      // 配置值不可用时退回推导 —— 弹幕连不上比整个页面崩掉好
      return `${pageWsScheme()}//${window.location.hostname}:${WS_PORT}`;
    }
  }

  return `${pageWsScheme()}//${window.location.hostname}:${WS_PORT}`;
}

/**
 * 构造某集的弹幕房间地址。
 *
 * `playTimeMs` 是客户端**当前播放位置** —— 服务端据此决定回填哪一段窗口。
 * 不传的话服务端会从 0 开始取，播到后段就没有弹幕（这是原先的 bug）。
 *
 * ⚠️ 路径固定为 `/danmaku/room/<id>` —— **网关只匹配这个路径**
 * （见 `src/server/danmaku-gateway.ts` 的正则）。因此反向代理若用前缀
 * （如 `/danmaku-ws`），**必须剥掉前缀**再转发，否则网关收到
 * `/danmaku-ws/danmaku/room/1` 会直接拒绝升级。
 */
export function danmakuRoomUrl(
  episodeId: number,
  schoolOnly: boolean,
  playTimeMs = 0,
): string {
  const url = new URL(`${danmakuWsBase()}/danmaku/room/${episodeId}`);
  if (schoolOnly) url.searchParams.set("schoolOnly", "true");
  if (playTimeMs > 0) url.searchParams.set("playTimeMs", String(Math.round(playTimeMs)));
  return url.toString();
}
