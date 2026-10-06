"use client";

import { useState } from "react";

interface Props {
  /** 初始值（服务端已渲染过一次）。 */
  initialEnabled: boolean;
  /** 是否绑定了 Bangumi —— 未绑定时无处可同步。 */
  bgmBound: boolean;
  /** 运维硬闸当前是否关闭了全部镜像。 */
  opsDisabled: boolean;
}

/**
 * Bangumi 同步开关。
 *
 * ## 为什么默认关闭
 *
 * 写上游是**不可撤销**的：会覆盖用户在 Bangumi 上已有的短评、评分与进度。
 * 默认替他打开等于替他做了决定 —— 而且是在他不知道的情况下。
 *
 * ## 为什么文案要说「覆盖」
 *
 * 「同步」听起来是无害的复制，实际是**以本站的值为准覆盖上游**。用户
 * 在 Bangumi 网页端写过的短评，会被本站的同名字段盖掉。这一点必须写明。
 */
export default function MirrorSetting({ initialEnabled, bgmBound, opsDisabled }: Props) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !enabled;
    const previous = enabled;
    setEnabled(next);
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/settings/mirror", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mirrorToBgm: next }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "保存失败");
    } catch (e) {
      setEnabled(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel space-y-3 p-5">
      <h2 className="font-medium">同步到 Bangumi</h2>
      <p className="text-sm text-on-surface-variant">
        把你在本站的收藏状态、评分、短评与单集进度写回 Bangumi。
        <strong className="text-on-surface">
          会以本站的值覆盖你在 Bangumi 上的对应内容，且无法撤销。
        </strong>
        默认关闭。
      </p>

      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => void toggle()}
          disabled={busy || !bgmBound}
          className="size-4 accent-primary"
        />
        <span className={bgmBound ? "" : "text-on-surface-variant"}>
          {busy ? "保存中…" : "开启同步"}
        </span>
      </label>

      {!bgmBound && (
        <p className="text-xs text-on-surface-variant">
          尚未绑定 Bangumi，绑定后才能开启。
        </p>
      )}

      {/*
        运维硬闸。这里**只提示、不改用户的开关值** —— 硬闸随时可能被
        重新打开，用户的选择应当被记住，而不是被静默改写。
      */}
      {opsDisabled && (
        <p className="alert alert-warn text-xs">
          当前被管理员临时关闭了全部上游写入（通常在跑写库测试）。
          你的开关已保存，管理员恢复后会按你的选择生效。
        </p>
      )}

      {error && <p className="text-xs text-error">{error}</p>}
    </section>
  );
}
