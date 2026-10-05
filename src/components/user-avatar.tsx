"use client";

/*
 * 本文件刻意使用普通 `<img>`，理由见下方组件注释 —— 这里整文件禁用该规则，
 * 而不是逐行写 `eslint-disable-next-line`（后者跨行注释时容易指向错误的行）。
 */
/* eslint-disable @next/next/no-img-element */

import { useState } from "react";

interface Props {
  /** 头像地址；null 或加载失败时回退到昵称首字。 */
  url: string | null;
  nickname: string;
  /** 像素尺寸（正方）。 */
  size: number;
  className?: string;
  /** 悬停提示，例如「昵称 · 学校 · 管理员」。 */
  title?: string;
}

/** 昵称首字占位 —— 中文取首字，英文取首字母大写。 */
export function initialOf(nickname: string): string {
  return ([...nickname.trim()][0] ?? "?").toUpperCase();
}

/**
 * 用户头像。**刻意用普通 `<img>` 而不是 `next/image`。**
 *
 * ## 为什么不能用 next/image
 *
 * `next/image` 要求把图片主机写进 `next.config.ts` 的 `remotePatterns`，而
 * 头像这个功能**本身就邀请用户贴任意 https 直链**（设置页的文案就是这么写的）。
 * 两者根本冲突：
 *
 * - 允许列表里只有 `lain.bgm.tv` / `bgm.tv`（那是给**封面**用的）；
 * - 用户贴 `https://i.imgur.com/x.png` 后，页面照常渲染，但浏览器请求
 *   `/_next/image?url=...` 会拿到 **400 `"url" parameter is not allowed`** ——
 *   于是**每一页**（这个组件在根布局的侧栏里）都是裂图。
 *   实测确认过：允许主机 200，非允许主机 400。
 *
 * ## 普通 `<img>` 还更合适
 *
 * 1. **尺寸收益为零**：头像只有 24–64px，优化器省不下什么，却要为每个用户
 *    建一条服务端缓存。
 * 2. **信任模型正确**：`next/image` 是**我们的服务器**去抓用户给的 URL；
 *    普通 `<img>` 是**访客的浏览器**去抓。对「用户自己贴的第三方图床」，
 *    后者才是应该的 —— 不该让本站充当任意 URL 的抓取器。
 *
 * ## 加载失败要能回退
 *
 * 贴的链接可能失效或根本不是图片。若只显示裂图图标，用户会以为是本站坏了；
 * 回退到昵称首字则只是「看起来没设置头像」，且能在设置页改掉。
 * 这也是本组件必须是客户端组件的原因（需要 `onError`）。
 */
export default function UserAvatar({ url, nickname, size, className, title }: Props) {
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <span
        aria-hidden
        title={title}
        className={`flex shrink-0 items-center justify-center rounded-full bg-primary-container text-on-primary-container ${className ?? ""}`}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
      >
        {initialOf(nickname)}
      </span>
    );
  }

  return (
    <img
      src={url}
      alt=""
      title={title}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full object-cover ${className ?? ""}`}
      style={{ width: size, height: size }}
    />
  );
}
