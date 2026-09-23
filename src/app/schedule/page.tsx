import Image from "next/image";
import Link from "next/link";
import { SubjectType, searchSubjects } from "@/lib/bgm/client";
import { isoDate, parseIsoDate, weekRange, weekdayLabel } from "@/lib/schedule";

export const dynamic = "force-dynamic";

export const metadata = { title: "新番时间表 · hit-ani" };

/**
 * 新番时间表。
 *
 * Bangumi `v0` 无时间表端点 → 用 `air_date` 区间检索聚合，按日分组。
 * 数据不落库：时间表是探索路径，点进详情才缓存。
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
      items: (byDate.get(key) ?? []).sort(
        (a, b) => (b.rating?.total ?? 0) - (a.rating?.total ?? 0),
      ),
    };
  });

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="text-2xl font-semibold">新番时间表</h1>
        <p className="text-sm text-neutral-400">
          {isoDate(start)} ~ {isoDate(end)} · 共 {page?.total ?? 0} 部
        </p>
        <div className="flex gap-2 text-sm">
          <Link
            href={`/schedule?weekOffset=${weekOffset - 1}`}
            className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800"
          >
            上一周
          </Link>
          <Link
            href="/schedule"
            className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800"
          >
            本周
          </Link>
          <Link
            href={`/schedule?weekOffset=${weekOffset + 1}`}
            className="rounded border border-neutral-700 px-3 py-1.5 hover:bg-neutral-800"
          >
            下一周
          </Link>
        </div>
      </section>

      {page === null && (
        <p className="rounded border border-red-900 bg-red-950/40 p-4 text-sm text-red-300">
          获取时间表失败，请稍后重试。
        </p>
      )}

      <div className="space-y-6">
        {days.map((day) => (
          <section key={day.key} className="space-y-3">
            <h2 className="flex items-center gap-3 text-base font-medium">
              <span>{day.label}</span>
              <span className="font-mono text-xs text-neutral-500">{day.key}</span>
              <span className="text-xs text-neutral-600">{day.items.length} 部</span>
            </h2>

            {day.items.length === 0 ? (
              <p className="text-sm text-neutral-600">这天没有新番开播。</p>
            ) : (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                {day.items.map((item) => (
                  <li key={item.id}>
                    <Link
                      href={`/subjects/${item.id}`}
                      className="block overflow-hidden rounded border border-neutral-800 bg-neutral-900 transition hover:border-sky-600"
                    >
                      {item.images?.common && (
                        <Image
                          src={item.images.common}
                          alt={item.name_cn || item.name}
                          width={200}
                          height={266}
                          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 25vw, 16vw"
                          className="aspect-[3/4] w-full object-cover"
                        />
                      )}
                      <div className="space-y-1 p-2">
                        <p className="line-clamp-2 text-xs">
                          {item.name_cn || item.name}
                        </p>
                        <p className="text-[11px] text-neutral-500">
                          {item.rating?.score ? item.rating.score.toFixed(1) : "暂无评分"}
                        </p>
                      </div>
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
