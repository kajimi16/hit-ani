import Image from "next/image";
import Link from "next/link";
import { IconStar } from "@/components/icons";

interface PersonRow {
  personId: number;
  name: string;
  relation: string;
  imageUrl: string | null;
}

interface Props {
  ratingScore: number | null;
  rank: number | null;
  ratingTotal: number | null;
  bars: { score: number; count: number; percent: number }[];
  reviews: {
    id: string;
    title: string | null;
    content: string;
    rating: number | null;
    authorName: string;
    schoolId: string;
    likes: number;
    createdAt: string;
  }[];
  persons: PersonRow[];
  /** 本校标识 —— 用来给本校评价打标，与弹幕的筛选口径一致 */
  schoolId?: string;
  /** 「查看全部」链接的目标 */
  allReviewsHref: string;
}

/** 五颗星：按 10 分制换算（5.0 分 = 满分）。 */
function Stars({ score }: { score: number }) {
  const outOfFive = score / 2;
  return (
    <span className="rating-stars" aria-label={`${outOfFive.toFixed(1)} 星`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <IconStar key={star} size={16} filled={outOfFive >= star - 0.5} />
      ))}
    </span>
  );
}

/**
 * 把「一人多职」合并成一行。
 *
 * BGM 的人员接口是**扁平的「人 + 职位」**：同一个人担任「原作」与「脚本」时
 * 会出现两次。直接逐条渲染会让同一个人连着出现几行，看起来像重复数据。
 * 按 `personId` 合并、职位用「、」连接，与 Animeko 的展示一致。
 *
 * 保持**首次出现的顺序**：上游已按重要度排好，用 Map 的插入顺序即可，
 * 不要额外排序。
 */
function mergeByPerson(persons: PersonRow[]): { person: PersonRow; relations: string[] }[] {
  const merged = new Map<number, { person: PersonRow; relations: string[] }>();
  for (const person of persons) {
    const entry = merged.get(person.personId);
    if (entry) {
      entry.relations.push(person.relation);
    } else {
      merged.set(person.personId, { person, relations: [person.relation] });
    }
  }
  return [...merged.values()];
}

/**
 * 详情页右栏 —— 对应 Animeko 的侧栏右部：
 * 评分（大数字 + 星 + 排名人数 + 直方图）、热门评价、制作人员。
 */
export default function SubjectAside({
  ratingScore,
  rank,
  ratingTotal,
  bars,
  reviews,
  persons,
  schoolId,
  allReviewsHref,
}: Props) {
  const staff = mergeByPerson(persons);
  const hasHistogram = bars.some((bar) => bar.count > 0);

/**
 * 默认列出的制作人员数量。
 *
 * 12 位足够覆盖导演、脚本、音乐、角色设计、动画制作这些关键职位，
 * 又不至于把右栏拉长 —— 实测热门作品的人员可以到 243 条。
 */
const STAFF_PREVIEW_COUNT = 12;

/** 一行制作人员：头像 + 姓名 + 合并后的职位。 */
function renderStaffItem({ person, relations }: { person: PersonRow; relations: string[] }) {
  return (
    <div key={person.personId} className="staff-item">
      {person.imageUrl ? (
        <Image
          src={person.imageUrl}
          alt=""
          width={64}
          height={64}
          sizes="32px"
          className="staff-item__avatar"
        />
      ) : (
        <span className="staff-item__avatar block" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="staff-item__name text-on-surface">{person.name}</p>
        {/* 一人多职在这里合并显示，例如「原作、脚本」 */}
        <p className="staff-item__roles">{relations.join("、")}</p>
      </div>
    </div>
  );
}

  return (
    <div className="detail-column">
      {/* ---------------------------------------------------------- 评分 */}
      {(ratingScore !== null || hasHistogram) && (
        <section className="panel">
          <h2 className="detail-section-title">评分</h2>

          {ratingScore !== null ? (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="rating-score">{ratingScore.toFixed(1)}</span>
                <Stars score={ratingScore} />
              </div>
              <p className="text-xs text-on-surface-variant">
                {rank ? `Bangumi 排名 #${rank}` : "暂无排名"}
                {ratingTotal ? ` · ${ratingTotal.toLocaleString("zh-CN")} 人评分` : ""}
              </p>
            </div>
          ) : (
            <p className="text-sm text-on-surface-variant">Bangumi 暂无评分</p>
          )}

          {/*
            评分直方图（`RatingHistogram`）：柱高按**最大值**归一 ——
            按总数归一的话 10 分那根永远只有两三成高，看不出分布形状。
            每根柱子带 title，鼠标悬停能看到具体人数。

            **显示顺序是 10 → 1（从高分到低分）**，与 Bangumi 站内一致：
            读分布时注意力天然落在「多少人给了高分」上，把 10 放在最左边
            才一眼看得到。数据本身仍是 1→10 升序（`histogramBars`），
            这里只是渲染时反过来 —— 这样排序语义不会被显示需求污染。
          */}
          {hasHistogram && (
            <div className="mt-3 space-y-1">
              <div className="histogram" role="img" aria-label="评分分布（10 分到 1 分）">
                {[...bars].reverse().map((bar) => (
                  <div
                    key={bar.score}
                    className="histogram__bar"
                    style={{ height: `${bar.percent}%` }}
                    title={`${bar.score} 分：${bar.count} 人`}
                  />
                ))}
              </div>
              {/* 轴标签跟着一起反过来，否则「10 在左」而刻度写 1 会自相矛盾 */}
              <div className="flex justify-between font-mono text-[0.625rem] text-on-surface-variant">
                <span>10</span>
                <span>1</span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------- 热门评价 */}
      <section className="panel">
        <h2 className="detail-section-title">
          热门评价
          {reviews.length > 0 && (
            <Link href={allReviewsHref} className="ml-auto text-xs font-normal text-primary hover:underline">
              全部
            </Link>
          )}
        </h2>

        {reviews.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            还没有评价。在下方评论区写第一条。
          </p>
        ) : (
          <div className="space-y-2">
            {reviews.map((review) => (
              <article key={review.id} className="review-preview">
                <div className="review-preview__meta">
                  <span className="text-on-surface">{review.authorName}</span>
                  {schoolId && review.schoolId === schoolId && (
                    <span className="badge badge-accent">本校</span>
                  )}
                  {review.rating !== null && <span>{review.rating} 分</span>}
                  {/* 只显示有点赞的，避免一列「0 赞」的噪音 */}
                  {review.likes > 0 && <span>· {review.likes} 赞</span>}
                </div>
                {review.title && (
                  <p className="text-sm font-medium text-on-surface">{review.title}</p>
                )}
                <p className="review-preview__text text-on-surface-variant">{review.content}</p>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------- 制作人员 */}
      {/*
        制作人员：**默认只列前 12 位**，其余折起来。

        大热作品的人员列表可以到 240+ 条（实测《异国日记》243 条）——
        全渲染会把右栏拉成一根几千像素的长条，用户在到达「下一屏」之前
        得滚很久。Animeko 同样只列一部分再给「全部」入口；我们没有人员页，
        所以就地用 `<details>` 展开，避免为了折叠去新建一个路由。

        排序沿用上游的重要度顺序，切出来的前 12 位是最相关的（导演、脚本、
        音乐等），不是随机一段。
      */}
      {staff.length > 0 && (
        <section className="panel">
          <h2 className="detail-section-title">
            制作人员
            <span className="ml-auto text-xs font-normal text-on-surface-variant">
              共 {staff.length} 位
            </span>
          </h2>

          <div className="staff-list">
            {staff.slice(0, STAFF_PREVIEW_COUNT).map(renderStaffItem)}
          </div>

          {staff.length > STAFF_PREVIEW_COUNT && (
            <details className="group mt-3">
              <summary className="cursor-pointer text-xs text-primary marker:text-outline">
                <span className="group-open:hidden">
                  展开其余 {staff.length - STAFF_PREVIEW_COUNT} 位
                </span>
                <span className="hidden group-open:inline">收起</span>
              </summary>
              <div className="staff-list mt-3">
                {staff.slice(STAFF_PREVIEW_COUNT).map(renderStaffItem)}
              </div>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
