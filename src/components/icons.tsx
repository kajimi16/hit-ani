/**
 * 图标集（内联 SVG）。
 *
 * 为什么不用图标库：只需要十来个图标，而 Animeko 的视觉风格是
 * **Material Symbols 的线条风**（细描边、圆角端点、24dp 网格）。
 * 引入整套库（几百 KB）只为十来个图标不划算，且难精确对齐那套风格。
 *
 * 统一约定：
 * - 24×24 viewBox，与 Material Symbols 一致
 * - `stroke` 用 `currentColor`，因此颜色由父级文字色决定
 * - 线宽 1.8 —— Material 默认是 2，但 1.8 在小尺寸（20px）下更精致
 * - 圆角端点与圆角连接，贴合 Material 的线条风
 */

type IconProps = {
  /** 渲染尺寸（像素）。Animeko 侧栏用 24，行内用 16-18。 */
  size?: number;
  className?: string;
};

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none" as const,
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true,
  };
}

/** 探索 / 找番 —— 罗盘。Animeko 侧栏首项。 */
export function IconExplore({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </svg>
  );
}

/** 举报 —— 旗帜（Material 的 `flag`）。 */
export function IconFlag({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M5 21V4" />
      <path d="M5 4.5h9.5l-1 3 1 3H5" />
    </svg>
  );
}

/** 好友 —— 两个人（Material 的 `people`）。 */
export function IconPeople({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5" />
      <path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.5 14.8c2.4.6 4 2.3 4 5.2" />
    </svg>
  );
}

/** 时光机 —— 带指针的表盘（Material 的 `history`）。 */
export function IconHistory({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
      <path d="M3.5 4.5V10h5.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

/** 时间表 —— 日历。 */
export function IconCalendar({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </svg>
  );
}

/** 我的追番 —— 书签。 */
export function IconBookmark({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M6.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v14l-7-4-7 4V6a1.5 1.5 0 0 1 1.5-1.5z" />
    </svg>
  );
}

/** 媒体源 / 数据库。 */
export function IconDatabase({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </svg>
  );
}

/** 设置 —— 齿轮（简化版，避免线条过密在小尺寸下糊成一团）。 */
export function IconSettings({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" />
    </svg>
  );
}

/** 搜索 —— 放大镜。 */
export function IconSearch({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4 4" />
    </svg>
  );
}

/** 播放 —— 三角。 */
export function IconPlay({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M8 5.5v13l10-6.5z" fill="currentColor" />
    </svg>
  );
}

/** 用户 —— 头像占位。 */
export function IconUser({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </svg>
  );
}

/** 评分星。`filled` 用于已评分态。 */
export function IconStar({ size = 24, className, filled = false }: IconProps & { filled?: boolean }) {
  return (
    <svg {...base(size, className)} fill={filled ? "currentColor" : "none"}>
      <path d="m12 4 2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.7-5 2.7 1-5.6-4-3.9 5.5-.8z" />
    </svg>
  );
}

/** 弹幕 —— 带消息的气泡（用于弹幕计数徽标）。 */
export function IconComment({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20.5 11.5a7.5 7.5 0 0 1-10.9 6.7L4.5 19.5l1.3-4.1A7.5 7.5 0 1 1 20.5 11.5z" />
      <path d="M9 11h6M9 14h3.5" />
    </svg>
  );
}

/** 外部资源 —— 外链箭头。 */
export function IconExternal({ size = 24, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
      <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
    </svg>
  );
}

/** 展开/收起箭头（chevron）。`direction` 决定朝向。 */
export function IconChevron({
  size = 24,
  className,
  direction = "right",
}: IconProps & { direction?: "up" | "down" | "left" | "right" }) {
  const rotate = { up: 270, down: 90, left: 180, right: 0 }[direction];
  return (
    <svg {...base(size, className)} style={{ transform: `rotate(${rotate}deg)` }}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}
