/**
 * 主题偏好。
 *
 * ## 为什么默认是「深色」而不是「跟随系统」
 *
 * Animeko 的 `ThemeSettings.darkMode` 默认是 AUTO（跟随系统），这里不照搬。
 * 本项目此前已定「深色主题固定」，若改成默认跟随系统，**所有现有用户打开
 * 网页会发现界面突然变白** —— 换主题是用户可见的行为变化，不该由系统设置
 * 悄悄决定。因此「跟随系统」是一个**可以主动选**的选项，而不是默认值。
 *
 * ## 为什么存 localStorage 而不是数据库
 *
 * 主题是**设备级**偏好：同一个人在亮屏的工位和暗屏的宿舍会想要不同设置，
 * 而这些设备共用同一个账号。存本地还能避免首屏等接口 —— 主题必须在首次
 * 绘制前生效，否则会闪一下白（FOUC）。
 */

/** 三种可选模式。顺序即界面上从左到右的顺序。 */
export const THEME_MODES = ["system", "light", "dark"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

export const THEME_STORAGE_KEY = "hit-ani-theme";

/** 默认模式。见文件头：保持「深色固定」的既有决定。 */
export const DEFAULT_THEME_MODE: ThemeMode = "dark";

export const THEME_LABELS: Record<ThemeMode, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** 把「模式 + 系统偏好」解析成实际生效的主题（即 `data-theme` 的取值）。 */
export function resolveTheme(mode: ThemeMode, prefersLight: boolean): "light" | "dark" {
  if (mode === "system") return prefersLight ? "light" : "dark";
  return mode;
}

/** 读取已保存的模式；读不到（或隐私模式抛异常）时用默认值。 */
export function readThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

/**
 * 应用模式：写入偏好并立刻改变 `data-theme`。
 *
 * 立即生效是必需的 —— 否则用户点了「浅色」要等下一次导航才看到变化。
 */
export function applyThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下就只影响下次打开，不该让这一次的切换失败
  }
  document.documentElement.setAttribute(
    "data-theme",
    resolveTheme(mode, window.matchMedia("(prefers-color-scheme: light)").matches),
  );
}

/**
 * 首次绘制前执行的内联脚本。
 *
 * 必须是**内联同步**脚本：`useEffect` 在首次绘制之后才跑，那时用户已经看到
 * 默认配色 —— 从深色切到浅色会有一次刺眼的白闪。
 *
 * 写成一个字符串常量（而不是文件）是因为它得在 bundle 之前运行。它与
 * `applyThemeMode` 有约 8 行重复，这是**有意的**：脚本必须自成一体。
 * 存储键与模式取值由上面的常量拼进来，因此不会两处各写一份后漂移。
 *
 * 脚本是**无状态**的 —— 每次都用 `localStorage` 重新求值，不缓存 mode。
 * 否则用户在设置页切到「跟随系统」后，脚本里那个闭包变量仍是旧值，
 * 系统主题再变就没人响应了。
 *
 * `try/catch` 也是必需的：隐私模式下读 `localStorage` 会抛异常，
 * 那时退回默认主题，而不是让脚本挂掉、页面停在未着色状态。
 */
export const THEME_BOOTSTRAP_SCRIPT = `
(function () {
  var KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
  var MODES = ${JSON.stringify(THEME_MODES)};
  var DEFAULT = ${JSON.stringify(DEFAULT_THEME_MODE)};
  var media = window.matchMedia("(prefers-color-scheme: light)");
  function apply() {
    var stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) {}
    var mode = MODES.indexOf(stored) >= 0 ? stored : DEFAULT;
    document.documentElement.setAttribute(
      "data-theme",
      mode === "system" ? (media.matches ? "light" : "dark") : mode
    );
  }
  media.addEventListener("change", apply);
  apply();
})();
`.trim();
