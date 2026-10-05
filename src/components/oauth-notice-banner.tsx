"use client";

import { useEffect } from "react";
import type { OAuthNotice } from "@/lib/auth/oauth-result";

interface Props {
  notice: OAuthNotice;
}

/**
 * 绑定回调结果提示。
 *
 * 顺带把 URL 上的 `?bgm=…&reason=…` 清掉：那些参数只是「把结果传回这一页」的
 * 载体，留着会让用户**刷新时再看到一遍**已经过期的成功提示，也会被复制进
 * 书签或分享出去，让下一个人看到不属于他的提示。
 *
 * 用 `history.replaceState` 而不是 `router.replace`：后者会触发一次 RSC 导航，
 * 而这里只是清理地址栏，不需要重新取数，也避开了客户端路由在本机偶发不提交
 * 的老问题（见分页那次的记录）。
 */
export default function OAuthNoticeBanner({ notice }: Props) {
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const key of ["bgm", "qq", "reason"]) url.searchParams.delete(key);
    const cleaned = url.pathname + (url.searchParams.size > 0 ? `?${url.searchParams}` : "");
    window.history.replaceState(null, "", cleaned);
  }, []);

  const toneClass =
    notice.tone === "success" ? "alert-success" : notice.tone === "warn" ? "alert-warn" : "alert-danger";

  return (
    <div className={`alert ${toneClass}`} role="status">
      <p className="font-medium">{notice.title}</p>
      {notice.detail && <p className="mt-1 text-xs">{notice.detail}</p>}
    </div>
  );
}
