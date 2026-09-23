import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { countByEpisodeIds } from "@/lib/danmaku/repository";
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

      const fields = {
        type: detail.type,
        name: detail.name,
        nameCn: detail.name_cn || null,
        summary: detail.summary || null,
        coverUrl: detail.images?.large ?? detail.images?.common ?? null,
        airDate: parseDate(detail.date),
        score: detail.rating?.score ?? null,
        rank: detail.rating?.rank ?? null,
      };

      subject = await prisma.subject.upsert({
        where: { id: detail.id },
        create: { id: detail.id, tags: [], ...fields },
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
          airdate: parseDate(episode.airdate),
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

function parseDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}
