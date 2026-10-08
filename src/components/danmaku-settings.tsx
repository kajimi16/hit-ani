"use client";

import { useEffect, useState } from "react";
import {
  DANMAKU_LIMITS,
  DEFAULT_DANMAKU_STYLE,
  readDanmakuStyle,
  writeDanmakuStyle,
  type DanmakuStyle,
} from "@/lib/danmaku/style";

interface Props {
  /**
   * 样式变化回调。
   *
   * 播放器用它实时重绘 —— 不回调的话用户拖了滑块要等下一次播放才看到效果。
   */
  onChange: (style: DanmakuStyle) => void;
}

/** 一行可调项：标签 + 滑块 + 当前值。 */
function Slider(props: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block space-y-1 text-xs">
      <span className="flex items-baseline justify-between">
        <span className="text-on-surface-variant">{props.label}</span>
        <span className="font-mono text-on-surface">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
        className="w-full accent-primary"
      />
      {props.hint && <span className="block text-on-surface-variant/70">{props.hint}</span>}
    </label>
  );
}

/**
 * 弹幕显示设置。
 *
 * ## 初始值在挂载后才读
 *
 * 服务端不知道用户的设备偏好，首帧就渲染选中态会造成 hydration 不一致。
 * 与主题选择器同一处理：先渲染默认值，挂载后替换。
 */
export default function DanmakuSettings({ onChange }: Props) {
  const [style, setStyle] = useState<DanmakuStyle | null>(null);

  useEffect(() => {
    const stored = readDanmakuStyle();
    setStyle(stored);
    // 把已保存的样式同步给播放器 —— 否则用户上次调的字号这次不生效
    onChange(stored);
  }, [onChange]);

  const update = (patch: Partial<DanmakuStyle>) => {
    if (!style) return;
    const next = { ...style, ...patch };
    setStyle(next);
    writeDanmakuStyle(next);
    onChange(next);
  };

  // 挂载前用默认值渲染骨架（避免布局跳动），但不可交互
  const current = style ?? DEFAULT_DANMAKU_STYLE;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={current.enabled}
            disabled={style === null}
            onChange={() => update({ enabled: !current.enabled })}
            className="size-4 accent-primary"
          />
          <span>显示弹幕</span>
        </label>

        {/* 三类弹幕各自的开关 —— 有人只看滚动、不看顶底 */}
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={current.showScroll}
            disabled={style === null || !current.enabled}
            onChange={() => update({ showScroll: !current.showScroll })}
            className="size-4 accent-primary"
          />
          <span>滚动</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={current.showTop}
            disabled={style === null || !current.enabled}
            onChange={() => update({ showTop: !current.showTop })}
            className="size-4 accent-primary"
          />
          <span>顶部</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={current.showBottom}
            disabled={style === null || !current.enabled}
            onChange={() => update({ showBottom: !current.showBottom })}
            className="size-4 accent-primary"
          />
          <span>底部</span>
        </label>
      </div>

      {/* 关掉弹幕时把滑块也禁用 —— 让它们可拖但无效果会让人以为坏了 */}
      <div className={`grid gap-3 sm:grid-cols-2 ${current.enabled ? "" : "opacity-40"}`}>
        <Slider
          label="字号"
          value={current.fontSize}
          {...DANMAKU_LIMITS.fontSize}
          format={(v) => `${v}px`}
          onChange={(fontSize) => current.enabled && update({ fontSize })}
        />
        <Slider
          label="不透明度"
          value={current.opacity}
          {...DANMAKU_LIMITS.opacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(opacity) => current.enabled && update({ opacity })}
        />
        <Slider
          label="显示区域"
          hint="只占画面上部，留出字幕位置"
          value={current.area}
          {...DANMAKU_LIMITS.area}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(area) => current.enabled && update({ area })}
        />
        <Slider
          label="速度"
          value={current.speed}
          {...DANMAKU_LIMITS.speed}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(speed) => current.enabled && update({ speed })}
        />
      </div>
    </div>
  );
}
