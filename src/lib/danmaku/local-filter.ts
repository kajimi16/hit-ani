"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * 本地弹幕屏蔽（客户端正则）。
 *
 * 与服务端屏蔽词的分工：
 * - **服务端**（`src/lib/danmaku/filter.ts`）是管理员配的全局底线，违规内容对所有人挡
 * - **本模块**是用户自己的偏好（不想看剧透/某个梗），存 localStorage，即时生效、不走网络
 *
 * 为什么用正则而非纯文本：用户需要表达「包含 剧透 或 前面有提示」这类模式。
 * 正则的写法风险（灾难性回溯）由 `try/catch` 兜住 —— 非法正则直接忽略而不是崩页面。
 */

const STORAGE_KEY = "hit-ani:danmaku-filters";

export interface DanmakuFilterState {
  /** 已启用的正则列表 */
  patterns: string[];
  /** 全局开关：关掉后所有本地过滤都不生效（便于临时查看全部） */
  enabled: boolean;
}

const EMPTY: DanmakuFilterState = { patterns: [], enabled: true };

function read(): DanmakuFilterState {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<DanmakuFilterState>;
    return {
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((p): p is string => typeof p === "string")
        : [],
      enabled: parsed.enabled !== false,
    };
  } catch {
    return EMPTY;
  }
}

function write(state: DanmakuFilterState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式下可能写入失败，忽略 */
  }
}

/** 本地过滤状态与操作。 */
export function useDanmakuFilters() {
  const [state, setState] = useState<DanmakuFilterState>(EMPTY);

  // localStorage 只在客户端可读，因此挂载后再同步
  useEffect(() => {
    setState(read());
  }, []);

  const addPattern = useCallback(
    (pattern: string) => {
      const trimmed = pattern.trim();
      if (trimmed.length === 0) return;
      setState((prev) => {
        if (prev.patterns.includes(trimmed)) return prev;
        const next = { ...prev, patterns: [...prev.patterns, trimmed] };
        write(next);
        return next;
      });
    },
    [],
  );

  const removePattern = useCallback((pattern: string) => {
    setState((prev) => {
      const next = { ...prev, patterns: prev.patterns.filter((p) => p !== pattern) };
      write(next);
      return next;
    });
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setState((prev) => {
      const next = { ...prev, enabled };
      write(next);
      return next;
    });
  }, []);

  return { state, addPattern, removePattern, setEnabled };
}

/**
 * 按本地正则过滤弹幕文本。
 *
 * 非法正则**静默忽略**而不是抛错：用户在输入框里边打边生效时会短暂产生非法正则
 * （比如刚输入 `(`），此时应该只是不过滤，而不是让整个页面崩掉。
 */
export function applyLocalFilters<T extends { text: string }>(
  items: readonly T[],
  state: DanmakuFilterState,
): T[] {
  if (!state.enabled || state.patterns.length === 0) return [...items];

  const regexes: RegExp[] = [];
  for (const pattern of state.patterns) {
    try {
      regexes.push(new RegExp(pattern, "i"));
    } catch {
      // 非法正则跳过
    }
  }
  if (regexes.length === 0) return [...items];

  return items.filter((item) => !regexes.some((regex) => regex.test(item.text)));
}

/** 校验正则是否合法（供 UI 提示，不阻断输入）。 */
export function isValidPattern(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
