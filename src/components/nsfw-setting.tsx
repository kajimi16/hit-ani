"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DEFAULT_NSFW_PREFERENCE,
  NSFW_LABELS,
  parseNsfwCookie,
  writeNsfwCookie,
  type NsfwPreference,
} from "@/lib/nsfw";

/** 读取当前 cookie 里的偏好（服务端已渲染过一次，这里只是拿来做初值）。 */
function readCurrent(): NsfwPreference {
  if (typeof document === "undefined") return DEFAULT_NSFW_PREFERENCE;
  const match = document.cookie.match(new RegExp(`(?:^|; )${"hit-ani-nsfw"}=([^;]*)`));
  return parseNsfwCookie(match?.[1]);
}

/**
 * NSFW 内容偏好。
 *
 * 写入 cookie 后必须 `router.refresh()` 重新取数 —— 这个偏好决定服务端
 * **请求哪些条目**，不刷新的话当前页面上的列表不会变（与主题切换不同，
 * 主题只需改 CSS）。
 */
export default function NsfwSetting() {
  const router = useRouter();
  const [preference, setPreference] = useState<NsfwPreference>(readCurrent);

  const choose = (next: NsfwPreference) => {
    setPreference(next);
    writeNsfwCookie(next);
    // 服务端要按新的过滤条件重新查一遍
    router.refresh();
  };

  return (
    <section className="panel space-y-3 p-5">
      <h2 className="font-medium">R18 / NSFW 内容</h2>
      <p className="text-sm text-on-surface-variant">
        控制探索页与时间表里是否包含 R18 条目。只影响这台设备。
      </p>

      <div role="radiogroup" aria-label="NSFW 内容" className="flex flex-wrap gap-2">
        {(["hide", "show"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={preference === option}
            onClick={() => choose(option)}
            className={`btn btn-sm ${preference === option ? "btn-primary" : "btn-ghost"}`}
          >
            {NSFW_LABELS[option]}
          </button>
        ))}
      </div>

      <p className="text-xs text-on-surface-variant">
        {/*
          如实说明：Bangumi 的 nsfw 参数需要账号权限，无权限时会被静默忽略。
          说成「显示全部 R18」会让用户以为是本站的问题。
        */}
        「显示」表示**不再主动过滤**。能不能查到 R18 条目取决于你 Bangumi 账号的
        权限 —— 没有权限时 Bangumi 会忽略该选项，此时结果与「不显示」相同。
      </p>
    </section>
  );
}
