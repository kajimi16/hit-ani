import Image from "next/image";
import Link from "next/link";
import { IconStar } from "@/components/icons";

/** 列表 / 网格共用的条目数据形状。 */
export interface LibraryItem {
  collectionId: string;
  subjectId: number;
  title: string;
  originalTitle: string;
  coverUrl: string | null;
  /** BGM 评分（10 分制） */
  bgmScore: number | null;
  /** 我的评分（10 分制），未评为 null */
  myRating: number | null;
  /** 我的短评，未写为 null */
  myComment: string | null;
  /** 该用户在 BGM 的排名（越小越好），无则为 null */
  bgmRank: number | null;
  watchedEpisodes: number;
  totalEpisodes: number;
  /** 加入收藏时间（可能未知） */
  collectedAt: string | null;
  /**
   * 上次看到的位置（毫秒）；从未播放过时 null。
   *
   * **不是 0** —— 0 表示「从片头继续」，null 表示「没有可续播的位置」。
   * 列表只在非 null 时显示，否则每张卡都挂个「00:00」是噪音。
   */
  resumePositionMs: number | null;
  statusLabel: string;
}

/** 五颗星，按 10 分制换算。 */
function Stars({ score }: { score: number }) {
  const outOfFive = score / 2;
  return (
    <span className="inline-flex gap-px text-primary" aria-label={`${outOfFive.toFixed(1)} 星`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <IconStar key={star} size={13} filled={outOfFive >= star - 0.5} />
      ))}
    </span>
  );
}

/**
 * 网格视图的卡片。
 *
 * 用 `SubjectCard` 同一套 9:16 比例（`SubjectCoverCard`），
 * 保持首页与追番页的封面裁切一致。
 */
export function LibraryGridCard({ item }: { item: LibraryItem }) {
  return (
    <Link href={`/subjects/${item.subjectId}`} className="subject-card">
      {item.coverUrl ? (
        <Image
          src={item.coverUrl}
          alt=""
          fill
          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 25vw, 16vw"
          className="object-cover"
        />
      ) : (
        <div className="absolute inset-0" aria-hidden />
      )}

      <div className="subject-card__scrim">
        <span className="subject-card__title">{item.title}</span>
        <span className="subject-card__progress">
          {item.myRating !== null ? `我评 ${item.myRating} 分` : `BGM ${item.bgmScore?.toFixed(1) ?? "暂无"}`}
          {item.totalEpisodes > 0 ? ` · ${item.watchedEpisodes}/${item.totalEpisodes}` : ""}
        </span>
      </div>
    </Link>
  );
}

/**
 * 列表视图的一行。
 *
 * 按用户要求显示：封面、标题、BGM 评分、**本账号的评分与评论**。
 * 我的评分与评论是这个视图存在的理由 —— 网格卡片放不下评论，
 * 而「我当初为什么给这部打这个分」正是回看收藏时最想确认的东西。
 */
export function LibraryListRow({ item }: { item: LibraryItem }) {
  return (
    <li className="border-b border-outline-variant last:border-b-0">
      <Link
        href={`/subjects/${item.subjectId}`}
        className="lift flex gap-4 rounded-md p-2 hover:bg-surface-container"
      >
        <div className="relative w-14 shrink-0 overflow-hidden rounded" style={{ aspectRatio: "9 / 16" }}>
          {item.coverUrl ? (
            <Image src={item.coverUrl} alt="" fill sizes="56px" className="object-cover" />
          ) : (
            <div className="absolute inset-0 bg-surface-container-high" aria-hidden />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p className="line-clamp-1 text-sm font-medium">{item.title}</p>
            <span className="badge">{item.statusLabel}</span>
          </div>
          {/* 原名只在有中文名时才补一行，避免重复 */}
          {item.originalTitle !== item.title && (
            <p className="line-clamp-1 text-xs text-on-surface-variant">{item.originalTitle}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
            <span>BGM {item.bgmScore?.toFixed(1) ?? "暂无"}</span>
            {item.bgmRank !== null && <span className="font-mono">#{item.bgmRank}</span>}
            {item.totalEpisodes > 0 && (
              <span className="font-mono">
                {item.watchedEpisodes}/{item.totalEpisodes} 集
              </span>
            )}
            {item.collectedAt && <span>{item.collectedAt.slice(0, 10)} 加入</span>}
            {item.resumePositionMs !== null && (
              <span className="text-primary">上次看到 {formatDuration(item.resumePositionMs)}</span>
            )}
          </div>

          {/* 我的评分 / 评论 —— 列表视图的核心内容 */}
          {item.myRating !== null ? (
            <div className="flex items-center gap-2 text-xs">
              <Stars score={item.myRating} />
              <span className="text-primary">{item.myRating} 分</span>
            </div>
          ) : (
            <p className="text-xs text-on-surface-variant">未评分</p>
          )}

          {item.myComment && (
            <p className="line-clamp-2 text-xs leading-relaxed text-on-surface-variant">
              {item.myComment}
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}

/** 毫秒 → `mm:ss`（超过一小时给 `h:mm:ss`）。续播位置靠它读起来才有意义。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}
