import Image from "next/image";
import Link from "next/link";
import { IconPlay } from "@/components/icons";

interface Props {
  href: string;
  title: string;
  /** BGM 封面地址；缺省时渲染同尺寸占位块（保持网格不塌） */
  image?: string | null;
  /** 卡片底部第二行小字 —— Animeko 用它显示观看进度（「看到 12」） */
  subtitle?: string | null;
  /** 有新集可看时显示播放角标 */
  playable?: boolean;
  /** 首屏前几张立即加载，其余懒加载 */
  priority?: boolean;
  sizes?: string;
  /** 用于轮播（圆角 28px）而非网格（圆角 16px） */
  variant?: "grid" | "hero";
}

/**
 * Animeko 的条目封面卡。
 *
 * 结构对应 `SubjectCoverCard` → `BasicCarouselItem`：
 * 9:16 封面 + 底部渐变 + 标题（≤2 行）+ 支持文字（1 行）。
 *
 * **刻意不放评分角标** —— Animeko 的卡片上没有任何评分/集数徽标，
 * 唯一的叠加层是「有新集」时的播放按钮。评分只在详情页出现。
 */
export default function SubjectCard({
  href,
  title,
  image,
  subtitle,
  playable = false,
  priority = false,
  sizes = "(max-width: 640px) 33vw, (max-width: 1024px) 25vw, 16vw",
  variant = "grid",
}: Props) {
  return (
    <Link href={href} className={variant === "hero" ? "hero-card" : "subject-card"}>
      {image ? (
        <Image
          src={image}
          alt=""
          fill
          priority={priority}
          sizes={sizes}
          className="object-cover"
        />
      ) : (
        <div className="absolute inset-0" aria-hidden />
      )}

      <div className="subject-card__scrim">
        <span className="subject-card__title">{title}</span>
        {subtitle ? <span className="subject-card__progress">{subtitle}</span> : null}
      </div>

      {playable && (
        <span className="subject-card__play" title="有新集可看">
          <IconPlay size={20} />
        </span>
      )}
    </Link>
  );
}
