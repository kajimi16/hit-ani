import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { countByEpisodeIds } from "@/lib/danmaku/repository";
import { subjectFieldsFromDetail } from "@/lib/bgm/subject-fields";
import { parseIsoDate } from "@/lib/date";
import { getSubject, getSubjectEpisodes } from "@/lib/bgm/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/subjects/{id}
 *
 * 本地缓存优先；未缓存时回源 BGM 并落库（章节必须落库 —— 它是弹幕的外键挂载点）。
 * 同时返回整季弹幕密度，供章节列表展示「本校 / 全体」对比。
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const subjectId = Number(id);
  if (!Number.isInteger(subjectId) || subjectId <= 0) {
    return NextResponse.json({ error: "subjectId 不合法" }, { status: 400 });
  }

  const user = await getSessionUser();

  let subject = await prisma.subject.findUnique({
    where: { id: subjectId },
    include: { episodes: { orderBy: { sort: "asc" } } },
  });

  if (!subject || subject.episodes.length === 0) {
    try {
      const [detail, page] = await Promise.all([
        getSubject(subjectId),
        getSubjectEpisodes(subjectId, { limit: 100 }),
      ]);

      // 这里此前漏了 `ratingTotal` 与 `ratingHistogram` —— 于是走这条路径
      // 缓存的条目，详情页右栏的「N 人评分」与评分直方图永远是空的。
      // 字段清单现已集中到 `@/lib/bgm/subject-fields`，两处共用一份。
      const fields = subjectFieldsFromDetail(detail);

      subject = await prisma.subject.upsert({
        where: { id: detail.id },
        // `fields` 已带 tags（可能为空数组），不再单独给 `tags: []`
        create: { id: detail.id, ...fields },
        update: fields,
        include: { episodes: { orderBy: { sort: "asc" } } },
      });

      for (const episode of page.data) {
        const episodeFields = {
          subjectId,
          sort: episode.sort,
          ep: episode.ep ?? null,
          name: episode.name,
          nameCn: episode.name_cn || null,
          airdate: parseIsoDate(episode.airdate),
          duration: episode.duration || null,
        };
        await prisma.episode.upsert({
          where: { id: episode.id },
          create: { id: episode.id, ...episodeFields },
          update: episodeFields,
        });
      }

      subject = await prisma.subject.findUniqueOrThrow({
        where: { id: subjectId },
        include: { episodes: { orderBy: { sort: "asc" } } },
      });
    } catch (error) {
      return NextResponse.json(
        {
          error: "获取条目失败",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 502 },
      );
    }
  }

  const episodeIds = subject.episodes.map((episode) => episode.id);
  const [danmakuCounts, schoolCounts, collection] = await Promise.all([
    countByEpisodeIds(episodeIds),
    user ? countByEpisodeIds(episodeIds, user.schoolId) : Promise.resolve({} as Record<number, number>),
    user
      ? prisma.collection.findUnique({
          where: { userId_subjectId: { userId: user.id, subjectId } },
        })
      : Promise.resolve(null),
  ]);

  return NextResponse.json({
    subject: {
      id: subject.id,
      type: subject.type,
      name: subject.name,
      nameCn: subject.nameCn,
      summary: subject.summary,
      coverUrl: subject.coverUrl,
      airDate: subject.airDate,
      score: subject.score,
      rank: subject.rank,
    },
    episodes: subject.episodes.map((episode) => ({
      id: episode.id,
      sort: episode.sort,
      ep: episode.ep,
      name: episode.name,
      nameCn: episode.nameCn,
      airdate: episode.airdate,
      duration: episode.duration,
      danmakuCount: danmakuCounts[episode.id] ?? 0,
      schoolDanmakuCount: schoolCounts[episode.id] ?? 0,
    })),
    collection,
  });
}

// 日期解析统一用 `@/lib/bgm/subject-fields` 里那一份。此前这里是**第三份**
// 复制品，且同样有「13 月 45 日」被 `Date.UTC` 静默进位的问题 ——
// 三份各自演化，其中两份带着同一个 bug。
