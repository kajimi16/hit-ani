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
 * ## 策略
 *
 * 1. 构建期显式配置了 `NEXT_PUBLIC_DANMAKU_WS_URL` → 用它（适合反向代理场景）
 * 2. 否则**从页面地址推导主机名**，端口取 `NEXT_PUBLIC_DANMAKU_WS_PORT`（默认 3102）
 *
 * 推导的好处是镜像与主机名无关：用 IP 访问就连那个 IP，用域名访问就连域名，
 * 本地开发也自动是 localhost，无需任何配置。
 */

const WS_PORT = process.env.NEXT_PUBLIC_DANMAKU_WS_PORT ?? "3102";

/** 显式配置优先；为空/未设置时返回 null 表示「按页面地址推导」。 */
const CONFIGURED = process.env.NEXT_PUBLIC_DANMAKU_WS_URL?.trim() || null;

/**
 * 解析出弹幕网关的 WS 基址。
 *
 * 必须在客户端调用（需要 `window`）。SSR 阶段返回空串 —— 弹幕组件都是
 * `"use client"` 且只在 effect 里连接，不会走到 SSR 分支。
 */
export function danmakuWsBase(): string {
  if (CONFIGURED) return CONFIGURED;
  if (typeof window === "undefined") return "";

  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.hostname}:${WS_PORT}`;
}

/** 构造某集的弹幕房间地址。 */
export function danmakuRoomUrl(episodeId: number, schoolOnly: boolean): string {
  const base = danmakuWsBase();
  const url = new URL(`${base}/danmaku/room/${episodeId}`);
  if (schoolOnly) url.searchParams.set("schoolOnly", "true");
  return url.toString();
}
