import Image from "next/image";
import Link from "next/link";
import CollectionPicker from "@/components/collection-picker";
import type { CollectionStatusValue } from "@/lib/collection";

interface Props {
  subject: {
    id: number;
    name: string;
    nameCn: string | null;
    coverUrl: string | null;
    airDate: Date | null;
    score: number | null;
    rank: number | null;
    ratingTotal: number | null;
    tags: string[];
  };
  episodeCount: number;
  /** 全站收藏统计（不是当前用户的）—— 这就是「在看人数」的来源。 */
  stats: { wish: number; doing: number; done: number };
  /** 当前用户的收藏状态 */
  myStatus: CollectionStatusValue | null;
  canInteract: boolean;
  bgmBound: boolean;
  /** 标签链接的构造 —— 点标签跳到按该标签筛选的探索页 */
  tagHref: (tag: string) => string;
}

/**
 * 详情页左栏 —— 对应 Animeko 的 `SubjectDetailsSidebar`：
 * 封面 + 收藏按钮 + 收藏统计 + 作品信息 + 标签。
 *
 * 收藏统计（想看/在看/看过）是**全站**口径，不是当前用户的 ——
 * 「在看人数」这种信息只有在跨用户聚合时才有意义，也才是用户想看的。
 */
export default function SubjectSidebar({
  subject,
  episodeCount,
  stats,
  myStatus,
  canInteract,
  bgmBound,
  tagHref,
}: Props) {
  return (
    <div className="detail-column detail-sidebar">
      {/* ---------------------------------------------------------- 封面与标题 */}
      <section className="space-y-3">
        {subject.coverUrl ? (
          <Image
            src={subject.coverUrl}
            alt={subject.nameCn ?? subject.name}
            width={849}
            height={1200}
            priority
            sizes="340px"
            className="poster-image w-full rounded-lg shadow-lg"
          />
        ) : (
          <div className="poster-image w-full rounded-lg" />
        )}

        <div className="space-y-1">
          <h1 className="text-xl font-normal leading-snug">
            {subject.nameCn || subject.name}
          </h1>
          {/* 原名只在与中文名不同时才重复显示 */}
          {subject.nameCn && subject.name !== subject.nameCn && (
            <p className="text-xs text-on-surface-variant">{subject.name}</p>
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------- 收藏 */}
      <CollectionPicker
        subjectId={subject.id}
        initialStatus={myStatus}
        canInteract={canInteract}
        bgmBound={bgmBound}
      />

      {/* ---------------------------------------------------------- 收藏统计 */}
      <section className="panel">
        <h2 className="detail-section-title">收藏情况</h2>
        <div className="stat-row">
          <div>
            <div className="stat-value">{stats.doing.toLocaleString("zh-CN")}</div>
            <div className="stat-label">在看</div>
          </div>
          <div>
            <div className="stat-value">{stats.wish.toLocaleString("zh-CN")}</div>
            <div className="stat-label">想看</div>
          </div>
          <div>
            <div className="stat-value">{stats.done.toLocaleString("zh-CN")}</div>
            <div className="stat-label">看过</div>
          </div>
        </div>
        <p className="mt-2 text-[0.6875rem] text-on-surface-variant">
          本站用户的数据，不含 Bangumi 全站。
        </p>
      </section>

      {/* ---------------------------------------------------------- 作品信息 */}
      <section className="panel">
        <h2 className="detail-section-title">作品信息</h2>
        <dl className="info-table">
          <dt>首播</dt>
          <dd>{subject.airDate?.toISOString().slice(0, 10) ?? "未定档"}</dd>

          <dt>话数</dt>
          <dd>{episodeCount > 0 ? `${episodeCount} 集` : "未知"}</dd>

          <dt>评分</dt>
          <dd>
            {subject.score ? `${subject.score.toFixed(1)} 分` : "暂无"}
            {subject.ratingTotal ? (
              <span className="text-on-surface-variant">
                {" "}
                （{subject.ratingTotal.toLocaleString("zh-CN")} 人）
              </span>
            ) : null}
          </dd>

          <dt>排名</dt>
          <dd>{subject.rank ? `#${subject.rank}` : "暂无"}</dd>
        </dl>

        <p className="mt-3 text-[0.6875rem] text-on-surface-variant">
          条目与章节元数据来自 Bangumi。
        </p>
      </section>

      {/* ---------------------------------------------------------- 标签
          取前 8 个：BGM 返回的标签可以到 30 个（实测），全列出来会把侧栏
          撑得很长。`SubjectTagsSection` 同样限制显示数量。
          上游已按热度（count）排序，因此前 8 个就是最相关的 8 个。 */}
      {subject.tags.length > 0 && (
        <section className="panel">
          <h2 className="detail-section-title">标签</h2>
          <div className="tag-list">
            {subject.tags.slice(0, 8).map((tag) => (
              <Link key={tag} href={tagHref(tag)} className="tag-chip">
                {tag}
              </Link>
            ))}
          </div>
          {subject.tags.length > 8 && (
            <p className="mt-2 text-[0.6875rem] text-on-surface-variant">
              另有 {subject.tags.length - 8} 个标签
            </p>
          )}
        </section>
      )}
    </div>
  );
}
