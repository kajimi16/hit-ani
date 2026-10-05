"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  IconBookmark,
  IconCalendar,
  IconDatabase,
  IconExplore,
  IconHistory,
  IconSettings,
} from "@/components/icons";
import UserMenu from "@/components/user-menu";

interface NavItem {
  href: string;
  label: string;
  icon: (props: { size?: number }) => React.ReactElement;
  /** 当前路径是否属于这一项（子页面也算） */
  match: (path: string) => boolean;
}

interface Props {
  isAdmin: boolean;
  /** 已登录时把「设置」指向账号页；未登录指向登录页 */
  user: {
    nickname: string;
    schoolId: string;
    isAdmin: boolean;
    /** 头像地址；null 时显示昵称首字占位。 */
    avatarUrl: string | null;
  } | null;
}

/**
 * 主导航 —— 对应 Animeko 的 `AniNavigationSuite`。
 *
 * 它按窗口宽度切换两种形态（`calculateLayoutType`）：
 * - 宽（≥840px）：`NavigationRail` 竖排，12px 药丸选中态
 * - 窄（<840px）：`NavigationBar` 吸底
 *
 * 两种形态共用同一份 `items`，避免两处各写一遍导致内容漂移。
 *
 * 注：Animeko 侧栏只有「探索 / 追番 / 下载」+ 设置；时间表是探索页里的
 * **按钮**而不是侧栏项。这里把时间表提升为顶级项 —— 它是本项目的核心功能
 * 之一（按播出日追更），藏在二级入口不合适。媒体源同理（仅管理员）。
 */
export default function SideNav({ isAdmin, user }: Props) {
  const pathname = usePathname();

  const items: NavItem[] = [
    {
      href: "/",
      label: "探索",
      icon: IconExplore,
      // 条目详情也算探索的一部分 —— 从详情返回时侧栏不应该失去高亮
      match: (p) => p === "/" || p.startsWith("/subjects/"),
    },
    { href: "/library", label: "追番", icon: IconBookmark, match: (p) => p.startsWith("/library") },
    { href: "/schedule", label: "时间表", icon: IconCalendar, match: (p) => p.startsWith("/schedule") },
    { href: "/timeline", label: "时光机", icon: IconHistory, match: (p) => p.startsWith("/timeline") },
  ];

  if (isAdmin) {
    items.push({
      href: "/sources",
      label: "媒体源",
      icon: IconDatabase,
      match: (p) => p.startsWith("/sources"),
    });
  }

  const renderItem = (item: NavItem) => {
    const active = item.match(pathname);
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        className="nav-item"
      >
        <span className="nav-item__icon">
          <Icon size={22} />
        </span>
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <>
      {/* ---------- 宽屏：侧边栏 ---------- */}
      <aside className="nav-rail">
        <Link
          href="/"
          className="flex items-center justify-center gap-2 px-1 py-2 text-sm font-medium"
          aria-label="hit-ani 首页"
        >
          {/*
            色块标识 —— 不引入资源请求，且跟随主题的 primary 色。
            窄栏时只显示色块，展开后才带文字。
          */}
          <span
            aria-hidden
            className="size-7 shrink-0 rounded-[0.6rem] bg-gradient-to-br from-primary to-primary-container"
          />
          <span className="hidden text-on-surface xl:inline">hit-ani</span>
        </Link>

        <nav className="flex flex-col gap-1">{items.map(renderItem)}</nav>

        {/* 账号区固定在底部 —— `mt-auto` 推到栏底。
            窄栏（<1200px）只放图标：昵称在这个宽度里会被挤成省略号。 */}
        <div className="mt-auto flex flex-col gap-2">
          <Link
            href="/settings"
            className="nav-item"
            aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          >
            <span className="nav-item__icon">
              <IconSettings size={22} />
            </span>
            <span>设置</span>
          </Link>

          {user ? (
            <>
              <div className="hidden xl:block">
                <UserMenu
                  nickname={user.nickname}
                  schoolId={user.schoolId}
                  isAdmin={user.isAdmin}
                  avatarUrl={user.avatarUrl}
                />
              </div>
              <div className="xl:hidden">
                <UserMenu
                  nickname={user.nickname}
                  schoolId={user.schoolId}
                  isAdmin={user.isAdmin}
                  avatarUrl={user.avatarUrl}
                  compact
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1 px-1">
              <Link href="/register" className="btn btn-primary btn-sm">
                注册
              </Link>
              <Link href="/login" className="btn btn-text btn-sm">
                登录
              </Link>
            </div>
          )}
        </div>
      </aside>

      {/* ---------- 窄屏：吸底栏 ---------- */}
      <nav className="nav-bar" aria-label="主导航">
        {items.map(renderItem)}
        <Link
          href="/settings"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className="nav-item"
        >
          <span className="nav-item__icon">
            <IconSettings size={22} />
          </span>
          <span>设置</span>
        </Link>
      </nav>
    </>
  );
}
