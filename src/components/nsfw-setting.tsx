"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DEFAULT_NSFW_PREFERENCE,
  NSFW_COOKIE,
  NSFW_LABELS,
  parseNsfwCookie,
  writeNsfwCookie,
  type NsfwPreference,
} from "@/lib/nsfw";

/** 读取当前 cookie 里的偏好（服务端已渲染过一次，这里只是拿来做初值）。 */
function readCurrent(): NsfwPreference {
  if (typeof document === "undefined") return DEFAULT_NSFW_PREFERENCE;
  // 用导出的常量而不是字面量：cookie 名在写入侧（`writeNsfwCookie`）与本处
  // 必须一致，抄两份的话改名时只改一处 —— 症状是「设置了但读不回来」。
  const match = document.cookie.match(new RegExp(`(?:^|; )${NSFW_COOKIE}=([^;]*)`));
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
    </section>
  );
}
