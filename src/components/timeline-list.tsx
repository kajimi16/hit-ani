import Image from "next/image";
import Link from "next/link";
import { IconStar } from "@/components/icons";
import UserAvatar from "@/components/user-avatar";
import type { TimelineEvent } from "@/lib/timeline/types";

/** 事件类型 → 展示用的动词短语。 */
const KIND_PREFIX: Record<TimelineEvent["kind"], string> = {
  collection: "标记了",
  review: "评价了",
  danmaku: "在",
  progress: "更新进度",
};

/** 五颗星，按 10 分制换算。 */
function Stars({ score }: { score: number }) {
  const outOfFive = score / 2;
  return (
    <span className="inline-flex gap-px text-primary" aria-label={`${outOfFive.toFixed(1)} 星`}>
      {[1, 2, 3, 4, 5].map((star) => (
        <IconStar key={star} size={12} filled={outOfFive >= star - 0.5} />
      ))}
    </span>
  );
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期。 */
function relativeTime(at: Date, now = Date.now()): string {
  const diff = now - at.getTime();
  if (diff < 60_000) return "刚刚";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return at.toISOString().slice(0, 10);
}

/**
 * 时光机的一条活动。
 *
 * 左侧头像、右侧内容：这与人际动态流的惯例一致 —— 一眼看到「谁做了什么」。
 * 头像与昵称都指向同一个人，但本站没有用户主页，因此**不做成链接**
 * （点了无处可去比不可点更让人困惑）。
 */
function EventRow({ event }: { event: TimelineEvent }) {
  return (
    <li className="flex gap-3 border-b border-outline-variant py-3 last:border-b-0">
      <UserAvatar url={event.avatarUrl} nickname={event.nickname} size={36} />

      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">
          <span className="text-on-surface">{event.nickname}</span>
          <span className="text-on-surface-variant"> · {relativeTime(event.at)}</span>
        </p>

        <div className="flex gap-2">
          {event.coverUrl && (
            <Link href={`/subjects/${event.subjectId}`} className="shrink-0">
              <Image
                src={event.coverUrl}
                alt=""
                width={96}
                height={128}
                sizes="40px"
                className="w-10 rounded object-cover"
                style={{ aspectRatio: "9 / 16" }}
              />
            </Link>
          )}

          <div className="min-w-0 flex-1 space-y-0.5 text-sm">
            {/* 事件主体 —— 按类型拼一句话 */}
            <p className="text-on-surface-variant">
              {KIND_PREFIX[event.kind]}{" "}
              <Link
                href={`/subjects/${event.subjectId}`}
                className="text-on-surface hover:text-primary hover:underline"
              >
                {event.subjectTitle}
              </Link>
              {event.kind === "collection" && (
                <>
                  {" "}
                  <span className="badge">{event.statusLabel}</span>
                  {event.rating !== null && (
                    <span className="ml-1 text-primary">{event.rating} 分</span>
                  )}
                </>
              )}
              {(event.kind === "danmaku" || event.kind === "progress") && (
                <span className="ml-1 text-on-surface-variant">{event.episodeLabel}</span>
              )}
              {event.kind === "progress" && (
                <span className="ml-1 badge">{event.progressLabel}</span>
              )}
              {event.kind === "review" && (
                <>
                  <span className="ml-1 badge">{event.isLong ? "影评" : "短评"}</span>
                  {event.rating !== null && <Stars score={event.rating} />}
                </>
              )}
            </p>

            {/* 附带的正文 —— 每种事件带的东西不同 */}
            {event.kind === "danmaku" && (
              <p className="line-clamp-2 text-on-surface-variant">「{event.text}」</p>
            )}
            {event.kind === "collection" && event.comment && (
              <p className="line-clamp-2 text-on-surface-variant">「{event.comment}」</p>
            )}
            {event.kind === "review" && (
              <>
                {event.title && <p className="font-medium text-on-surface">{event.title}</p>}
                <p className="line-clamp-2 text-on-surface-variant">{event.excerpt}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** 空状态：说明为什么这里是空的，而不是只留一片空白。 */
function EmptyState({ scope }: { scope: "bgm" | "school" }) {
  return (
    <p className="panel text-sm text-on-surface-variant">
      {scope === "bgm"
        ? "这个 Bangumi 账号还没有可供展示的活动。收藏过番剧后这里就会出现记录。"
        : "校内还没有人产生活动。去追番、发弹幕或写评论，这里就会有动静。"}
    </p>
  );
}

interface Props {
  events: TimelineEvent[];
  scope: "bgm" | "school";
}

export default function TimelineList({ events, scope }: Props) {
  if (events.length === 0) return <EmptyState scope={scope} />;

  return (
    <ul className="panel p-0">
      {events.map((event) => (
        <EventRow key={event.id} event={event} />
      ))}
    </ul>
  );
}
