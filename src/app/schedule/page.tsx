import Image from "next/image";
import Link from "next/link";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";
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
  searchParams: Promise<{ weekOffset?: string }>;
}) {
  const params = await searchParams;
  const raw = Number(params.weekOffset ?? 0);
  const weekOffset = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), -8), 8) : 0;

  const { start, end } = weekRange(new Date(), weekOffset);

  const page = await searchSubjects(
    {
      keyword: "",
      sort: "heat",
      filter: {
        type: [SubjectType.Anime] as never,
        air_date: [`>=${isoDate(start)}`, `<=${isoDate(end)}`],
        nsfw: false,
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

  return (
    <div className="space-y-6">
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
