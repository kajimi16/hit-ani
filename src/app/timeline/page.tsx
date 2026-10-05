import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import TimelineList from "@/components/timeline-list";
import { getSessionUser } from "@/lib/auth/session";
import { queryTimeline } from "@/lib/timeline/repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "时光机" };

/** 两个时光机的定义。顺序即标签页顺序。 */
const SCOPES = [
  { value: "school", label: "校内时光机" },
  { value: "bgm", label: "我的 Bangumi 时光机" },
] as const;

type Scope = (typeof SCOPES)[number]["value"];

function parseScope(raw: string | undefined): Scope {
  return raw === "bgm" ? "bgm" : "school";
}

/**
 * 时光机。
 *
 * ## 为什么是两个标签页而不是一个页面
 *
 * 两者回答的是不同问题：「校内时光机」= 这所学校的人最近在干什么；
 * 「我的 Bangumi 时光机」= **我自己**在 Bangumi 上的活动。
 * 混在一条流里会让「谁做的」变得难以分辨。
 *
 * ## 与 BGM 网页版时光机的差别（界面里已说明）
 *
 * Bangumi 的时光机是好友动态 + 微博客的聚合，**v0 API 没有对应端点**
 * （全部 `/v0/*` 路径逐个核对过）。因此这里的 BGM 时光机由该账号的收藏
 * 活动重建 —— 语义最接近，但不含日志、小组发言等我们拿不到的内容。
 * 如实说明比暗示「这就是 BGM 那个」更负责。
 */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const scope = parseScope((await searchParams).scope);

  /*
   * BGM 时光机只查**收藏**（`bgmOnly`）—— 那是唯一来自 Bangumi 的活动。
   * 站内的弹幕与观看进度属于「校内时光机」，混进来会让这一页的文案
   * （「你在 Bangumi 上的活动」）与内容对不上。
   */
  const events =
    scope === "bgm"
      ? user.bgmUsername
        ? await queryTimeline({ bgmUsername: user.bgmUsername, bgmOnly: true })
        : []
      : await queryTimeline({ schoolId: user.schoolId });

  // 没绑 BGM 时「我的 Bangumi 时光机」无内容可看，给出可操作的去向
  const bgmUnavailable = scope === "bgm" && !user.bgmBound;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-normal">时光机</h1>

      <nav className="flex flex-wrap gap-2" aria-label="时光机范围">
        {SCOPES.map((item) => (
          <Link
            key={item.value}
            href={item.value === "school" ? "/timeline" : `/timeline?scope=${item.value}`}
            aria-current={scope === item.value ? "page" : undefined}
            className={`rounded border px-3 py-1.5 text-sm transition ${
              scope === item.value
                ? "border-primary bg-primary-container text-on-primary-container"
                : "border-outline-variant bg-surface-container-low hover:border-outline"
            }`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <p className="text-xs text-on-surface-variant">
        {scope === "school" ? (
          <>
            本校（{user.schoolId}）用户在本站的活动：收藏、评分、评论、弹幕与观看进度。
            私密收藏不会出现在这里。
          </>
        ) : (
          <>
            你在 Bangumi 上的收藏活动。
            Bangumi 网页版的时光机还包含好友动态与小组发言，
            那些内容 <strong>API 不提供</strong>，因此这里只还原得收藏相关的部分。
            {bgmUnavailable && (
              <>
                {" "}
                <Link href="/settings" className="text-primary underline">
                  去绑定 Bangumi
                </Link>
                。
              </>
            )}
          </>
        )}
      </p>

      {bgmUnavailable ? (
        <p className="panel text-sm text-on-surface-variant">
          尚未绑定 Bangumi，无法展示你的 Bangumi 时光机。
        </p>
      ) : (
        <TimelineList events={events} scope={scope} />
      )}
    </div>
  );
}
