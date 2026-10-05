import Image from "next/image";
import Link from "next/link";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";
import { cookies } from "next/headers";
import { getSessionUser } from "@/lib/auth/session";
import {
  DEFAULT_LEADERBOARD_SORT,
  LEADERBOARD_SORTS,
  isLeaderboardSort,
  rankLeaderboard,
} from "@/lib/schedule-leaderboard";
import { buildLeaderboard } from "@/lib/schedule-leaderboard-query";
import { NSFW_COOKIE, nsfwFilterValue, parseNsfwCookie } from "@/lib/nsfw";
import { isoDate, parseIsoDate, weekRange, weekdayLabel } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export const metadata = { title: "新番时间表" };

/**
 * 新番时间表。
 *
 * Bangumi `v0` 无时间表端点 → 用 `air_date` 区间检索聚合，按日分组。
 * 数据不落库：时间表是探索路径，点进详情才缓存。
 *
 * 布局对齐 Animeko 的 `ScheduleScreen`：宽屏是**横向排列的日列**
 * （每列 360px，与 `ScheduleDayColumn` 一致），窄屏才纵向堆叠 ——
 * 手机上横向滚动很难同时看到两天，而宽屏横向排列能一眼扫完整周。
 * 条目是行（`ListItem`）而非大卡片：一天要列十几部，大卡片一屏放不下两三天。
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ weekOffset?: string; rank?: string }>;
}) {
  const params = await searchParams;
  const rankSort = isLeaderboardSort(params.rank) ? params.rank : DEFAULT_LEADERBOARD_SORT;
  const user = await getSessionUser();
  const raw = Number(params.weekOffset ?? 0);
  const weekOffset = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), -8), 8) : 0;

  const { start, end } = weekRange(new Date(), weekOffset);
  // NSFW 偏好与探索页同源（cookie），两处的过滤口径必须一致
  const nsfw = nsfwFilterValue(parseNsfwCookie((await cookies()).get(NSFW_COOKIE)?.value));

  const page = await searchSubjects(
    {
      keyword: "",
      sort: "heat",
      filter: {
        type: [SubjectType.Anime] as never,
        air_date: [`>=${isoDate(start)}`, `<=${isoDate(end)}`],
        ...(nsfw === undefined ? {} : { nsfw }),
      },
    },
    { limit: 50 },
  ).catch(() => null);

  const byDate = new Map<string, NonNullable<typeof page>["data"]>();
  for (const subject of page?.data ?? []) {
    if (!subject.date) continue;
    const list = byDate.get(subject.date) ?? [];
    list.push(subject);
    byDate.set(subject.date, list);
  }

  // 即使某天没有新番也要展示这一天，避免整周结构断裂
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * 24 * 60 * 60 * 1000);
    const key = isoDate(date);
    return {
      key,
      label: weekdayLabel(parseIsoDate(key)!, start),
      isToday: key === isoDate(new Date()),
      items: (byDate.get(key) ?? []).sort(
        (a, b) => (b.rating?.total ?? 0) - (a.rating?.total ?? 0),
      ),
    };
  });

  /*
   * 排行榜：只看**本周这几十部**（与时间表同一批条目），因此校内统计的
   * 样本量本来就小 —— 界面上会写明「本校 N 人评分」，避免把 1 人打的分
   * 当成有代表性的平均分。
   */
  const leaderboard = user
    ? rankLeaderboard(
        await buildLeaderboard({ subjects: page?.data ?? [], schoolId: user.schoolId }),
        rankSort,
      )
    : [];

  return (
    <div className="animate-rise space-y-6">
      <section className="space-y-3">
        <h1 className="text-2xl font-normal">新番时间表</h1>
        <p className="text-sm text-on-surface-variant">
          {isoDate(start)} ~ {isoDate(end)} · 共 {page?.total ?? 0} 部
        </p>
        <div className="flex gap-2 text-sm">
          <Link href={`/schedule?weekOffset=${weekOffset - 1}`} className="btn btn-ghost btn-sm">
            上一周
          </Link>
          <Link href="/schedule" className="btn btn-ghost btn-sm">
            本周
          </Link>
          <Link href={`/schedule?weekOffset=${weekOffset + 1}`} className="btn btn-ghost btn-sm">
            下一周
          </Link>
        </div>
      </section>

      {page === null && (
        <p className="alert alert-danger">获取时间表失败，请稍后重试。</p>
      )}

      {/*
        新番排行榜 —— 与时间表同一批条目（本周开播），两个板块的数据天然一致，
        不会出现「时间表里有、榜单里没有」的困惑。

        排序做成链接（`rank=` 查询参数）而不是客户端状态：这是服务端组件，
        排序在服务端完成，客户端只负责导航 —— 与追番页的排序同一套做法。
      */}
      {leaderboard.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-medium">新番排行榜</h2>
            <span className="text-xs text-on-surface-variant">本周开播 {leaderboard.length} 部</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {LEADERBOARD_SORTS.map((option) => (
                <a
                  key={option.value}
                  href={`/schedule?weekOffset=${weekOffset}&rank=${option.value}`}
                  aria-current={rankSort === option.value ? "true" : undefined}
                  className={`btn btn-sm ${rankSort === option.value ? "btn-primary" : "btn-ghost"}`}
                >
                  {option.label}
                </a>
              ))}
            </div>
          </div>

          <ol className="panel p-0">
            {leaderboard.map((entry, index) => (
              <li
                key={entry.subjectId}
                className="stagger-item border-b border-outline-variant last:border-b-0"
                // 逐项延迟，形成轻微瀑布感；上限 8 项（再多最后一项要等半秒）
                style={{ "--stagger": `${Math.min(index, 8) * 40}ms` } as React.CSSProperties}
              >
                <Link
                  href={`/subjects/${entry.subjectId}`}
                  className="flex items-center gap-3 p-2 transition-colors hover:bg-surface-container"
                >
                  {/* 名次：前三名用强调色，其余保持低调 —— 一眼看出头部 */}
                  <span
                    className={`w-6 shrink-0 text-center font-mono text-sm ${
                      index < 3 ? "font-semibold text-primary" : "text-on-surface-variant"
                    }`}
                  >
                    {index + 1}
                  </span>

                  {entry.coverUrl ? (
                    <Image
                      src={entry.coverUrl}
                      alt=""
                      width={72}
                      height={96}
                      sizes="36px"
                      className="w-9 shrink-0 rounded object-cover"
                      style={{ aspectRatio: "3 / 4" }}
                    />
                  ) : (
                    <span
                      className="w-9 shrink-0 rounded bg-surface-container-high"
                      style={{ aspectRatio: "3 / 4" }}
                      aria-hidden
                    />
                  )}

                  <span className="min-w-0 flex-1 truncate text-sm">{entry.title}</span>

                  {/*
                    四列指标。`—` 表示「没取到」而不是 0 —— BGM 人数只有在
                    该条目已进本地缓存时才有；本校人数与平均分是站内真实统计。
                  */}
                  <span className="hidden shrink-0 gap-4 text-xs sm:flex">
                    <span className="w-20 text-right">
                      <span className="text-on-surface-variant">BGM 在看 </span>
                      <span className="font-mono">{fmt(entry.bgmDoing)}</span>
                    </span>
                    <span className="w-16 text-right">
                      <span className="text-on-surface-variant">评分 </span>
                      <span className="font-mono">{entry.bgmScore?.toFixed(1) ?? "—"}</span>
                    </span>
                    <span className="w-20 text-right">
                      <span className="text-on-surface-variant">校内在看 </span>
                      <span className="font-mono">{entry.schoolDoing}</span>
                    </span>
                    <span className="w-28 text-right">
                      <span className="text-on-surface-variant">校内均分 </span>
                      <span className="font-mono">{entry.schoolAvgRating?.toFixed(1) ?? "—"}</span>
                      {entry.schoolRatedCount > 0 && (
                        <span className="text-on-surface-variant"> ({entry.schoolRatedCount})</span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>

          <p className="text-xs text-on-surface-variant">
            「—」表示该数据尚不可用（BGM 人数需先打开过该条目才会缓存）。
            括号内是参与评分的本校人数 —— 样本很小时平均分的参考价值有限。
          </p>
        </section>
      )}

      <div className="schedule-board">
        {days.map((day) => (
          <section key={day.key} className={`schedule-day${day.isToday ? " schedule-day--today" : ""}`}>
            <h2 className="schedule-day__headline">
              <span>{day.label}</span>
              <span className="font-mono text-xs text-on-surface-variant">{day.key}</span>
              <span className="ml-auto text-xs text-on-surface-variant">{day.items.length} 部</span>
            </h2>

            {day.items.length === 0 ? (
              <p className="text-sm text-on-surface-variant">这天没有新番开播。</p>
            ) : (
              <ul className="space-y-1">
                {day.items.map((item) => (
                  <li key={item.id}>
                    <Link href={`/subjects/${item.id}`} className="schedule-item">
                      {item.images?.common ? (
                        <Image
                          src={item.images.common}
                          alt=""
                          width={88}
                          height={156}
                          sizes="44px"
                          className="schedule-item__cover"
                        />
                      ) : (
                        <span className="schedule-item__cover block" aria-hidden />
                      )}
                      <span className="min-w-0">
                        <span className="schedule-item__title block">
                          {item.name_cn || item.name}
                        </span>
                        <span className="schedule-item__meta block">
                          {item.rating?.score ? `${item.rating.score.toFixed(1)} 分` : "暂无评分"}
                          {item.eps ? ` · ${item.eps} 集` : ""}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

/** 人数格式化：null 显示 `—` 而不是 0 —— 「没取到」与「确实是 0」不是一回事。 */
function fmt(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("zh-CN");
}
