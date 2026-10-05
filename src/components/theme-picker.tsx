"use client";

import { useEffect, useState } from "react";
import {
  THEME_LABELS,
  THEME_MODES,
  applyThemeMode,
  readThemeMode,
  type ThemeMode,
} from "@/lib/theme";

/**
 * 主题选择。
 *
 * 三项对应 Animeko `ThemeSettings` 的「浅色 / 深色 / 跟随系统」。
 *
 * 初始值必须**在挂载后**从 `localStorage` 读：服务端不知道用户的设备偏好，
 * 若在首帧就渲染选中态会造成 hydration 不一致。在此之前不标记任何一项为选中，
 * 而不是先猜「深色」—— 猜错会让用户看到选中态跳一下。
 */
export default function ThemePicker() {
  const [mode, setMode] = useState<ThemeMode | null>(null);

  useEffect(() => {
    setMode(readThemeMode());
  }, []);

  const choose = (next: ThemeMode) => {
    setMode(next);
    applyThemeMode(next);
  };

  return (
    <section className="panel space-y-3 p-5">
      <h2 className="font-medium">外观</h2>
      <p className="text-sm text-on-surface-variant">
        只影响这台设备。默认深色。「跟随系统」会随操作系统的浅色 / 深色设置自动切换。
      </p>

      <div role="radiogroup" aria-label="主题" className="flex flex-wrap gap-2">
        {THEME_MODES.map((option) => {
          const active = mode === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(option)}
              className={`btn btn-sm ${active ? "btn-primary" : "btn-ghost"}`}
            >
              {THEME_LABELS[option]}
            </button>
          );
        })}
      </div>
    </section>
  );
}
