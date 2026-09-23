"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  isAdmin: boolean;
}

/**
 * 顶部导航项。
 *
 * 需要高亮「当前所在页」—— 没有这个反馈时，用户点进二级页面后就不知道
 * 自己处在哪个板块了。这需要 `usePathname`，因此是客户端组件。
 */
export default function NavLinks({ isAdmin }: Props) {
  const pathname = usePathname();

  const links: { href: string; label: string; match: (p: string) => boolean }[] = [
    { href: "/", label: "找番", match: (p) => p === "/" || p.startsWith("/subjects/") },
    { href: "/schedule", label: "时间表", match: (p) => p.startsWith("/schedule") },
    { href: "/library", label: "我的追番", match: (p) => p.startsWith("/library") },
  ];

  if (isAdmin) {
    links.push({ href: "/sources", label: "媒体源", match: (p) => p.startsWith("/sources") });
  }

  return (
    <>
      {links.map((link) => {
        const active = link.match(pathname);
        return (
          <Link
            key={link.href}
            href={link.href}
            // aria-current 让屏幕阅读器也知道当前位置，而不只是视觉上不同
            aria-current={active ? "page" : undefined}
            className={`relative rounded-md px-3 py-1.5 text-sm transition-colors ${
              active
                ? "text-ink"
                : "text-ink-muted hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {link.label}
            {/*
              下划线而非换背景色表示选中：导航栏空间有限，
              背景块会让整条 nav 显得沉重。
            */}
            {active && (
              <span
                aria-hidden
                className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent"
              />
            )}
          </Link>
        );
      })}
    </>
  );
}
