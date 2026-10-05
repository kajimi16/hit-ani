import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPerson, getPersonWorks, type PersonWork } from "@/lib/bgm/client";

export const dynamic = "force-dynamic";

/**
 * 人物详情页。
 *
 * ## 为什么是「访问时获取」而不落库
 *
 * 与条目不同，人物页没有弹幕/评论之类的本地数据需要外键挂载 ——
 * 它纯粹是 BGM 数据的展示。落库只会带来「什么时候失效」的问题，
 * 而收益为零。因此每次访问直接回源，靠 Next 的请求缓存与 HTTP 缓存兜住。
 *
 * ## 为什么要做这个页面
 *
 * 详情页原本只列出 12 位制作人员，点了没反应。用户明确要求「制作人员可以
 * 点击，点击后拉取对应词条并进入详情页」—— BGM v0 的
 * `/v0/persons/{id}` 与 `/v0/persons/{id}/subjects` 正好提供这些内容。
 */

/** `blood_type` 是数字枚举（BGM 的 `BloodType`）。 */
const BLOOD_TYPE_LABELS: Record<number, string> = {
  1: "A 型",
  2: "B 型",
  3: "O 型",
  4: "AB 型",
};

/** `career` → 中文职业名。取不到时显示原文。 */
const CAREER_LABELS: Record<string, string> = {
  producer: "制作人",
  mangaka: "漫画家",
  artist: "艺术家",
  seiyu: "声优",
  writer: "作家",
  illustrator: "插画师",
  actor: "演员",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const personId = Number(id);
  if (!Number.isInteger(personId) || personId <= 0) return { title: "人物" };

  const person = await getPerson(personId).catch(() => null);
  return { title: person?.name ?? "人物" };
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const personId = Number(id);
  if (!Number.isInteger(personId) || personId <= 0) notFound();

  const [person, works] = await Promise.all([
    getPerson(personId).catch(() => null),
    // 作品列表拿不到不影响主体信息，因此单独 catch
    getPersonWorks(personId).catch((): PersonWork[] => []),
  ]);

  if (!person) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-semibold">人物 {personId}</h1>
        <p className="alert alert-warn">
          无法从 Bangumi 获取该人物。可能是网络问题或人物 ID 不存在。
        </p>
        <Link href="/" className="text-sm text-primary underline">
          返回找番
        </Link>
      </div>
    );
  }

  return (
    <div className="animate-rise space-y-6">
      {/* ---------------------------------------------------------- 头部 */}
      <section className="flex flex-col gap-5 sm:flex-row">
        {person.images?.large || person.images?.medium ? (
          <Image
            src={person.images.large ?? person.images.medium!}
            alt={person.name}
            width={220}
            height={293}
            priority
            sizes="160px"
            className="h-auto w-32 shrink-0 rounded-lg object-cover sm:w-40"
          />
        ) : null}

        <div className="min-w-0 space-y-3">
          <h1 className="text-2xl font-normal leading-snug">{person.name}</h1>

          {/* 职业标签 + 收藏数 */}
          <div className="flex flex-wrap items-center gap-2">
            {(person.career ?? []).map((career) => (
              <span key={career} className="badge badge-accent">
                {CAREER_LABELS[career] ?? career}
              </span>
            ))}
            {/* 收藏数在 `stat.collects` 上，不是顶层字段 */}
            {person.stat && person.stat.collects > 0 && (
              <span className="text-xs text-on-surface-variant">
                {person.stat.collects.toLocaleString("zh-CN")} 人收藏
              </span>
            )}
          </div>

          {/* 基本信息表 —— 只显示有值的项，避免一列「未知」 */}
          <dl className="info-table">
            {person.gender && (
              <>
                <dt>性别</dt>
                <dd>{{ male: "男", female: "女" }[person.gender] ?? person.gender}</dd>
              </>
            )}
            {person.birth_year && (
              <>
                <dt>生日</dt>
                <dd>
                  {person.birth_year} 年
                  {person.birth_mon ? ` ${person.birth_mon} 月` : ""}
                  {person.birth_day ? ` ${person.birth_day} 日` : ""}
                </dd>
              </>
            )}
            {person.blood_type && (
              <>
                <dt>血型</dt>
                <dd>{BLOOD_TYPE_LABELS[person.blood_type] ?? `${person.blood_type} 型`}</dd>
              </>
            )}
          </dl>

          {person.summary && (
            <p className="max-w-2xl whitespace-pre-wrap text-sm leading-relaxed text-on-surface-variant">
              {person.summary}
            </p>
          )}

          <p className="text-xs text-on-surface-variant">
            资料来自{" "}
            <a
              href={`https://bgm.tv/person/${personId}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline"
            >
              Bangumi
            </a>
            。
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- 参与作品 */}
      <section className="space-y-3">
        <h2 className="text-lg font-medium">
          参与作品
          <span className="ml-3 text-sm font-normal text-on-surface-variant">
            {works.length} 部
          </span>
        </h2>

        {works.length === 0 ? (
          <p className="panel text-sm text-on-surface-variant">
            没有取到参与作品。可能是上游暂时不可用。
          </p>
        ) : (
          <ul className="space-y-1">
            {works.map((work) => (
              <li key={work.id}>
                {/*
                  每行显示「作品 + 在这个作品里担任的职位」—— 那就是来访者
                  想知道的信息（这个人在这部番里做了什么）。
                */}
                <Link href={`/subjects/${work.id}`} className="schedule-item lift">
                  {work.image ? (
                    <Image
                      src={work.image}
                      alt=""
                      width={88}
                      height={117}
                      sizes="44px"
                      className="schedule-item__cover"
                    />
                  ) : (
                    <span className="schedule-item__cover block" aria-hidden />
                  )}
                  <span className="min-w-0">
                    <span className="schedule-item__title block">
                      {work.name_cn || work.name}
                    </span>
                    <span className="schedule-item__meta block">
                      {work.staff || "职位未标注"}
                      {work.eps ? ` · ${work.eps}` : ""}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
