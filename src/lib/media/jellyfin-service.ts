/**
 * Jellyfin / Emby 服务层 —— 连接的增删改查、BGM 条目与媒体库的匹配、播放地址生成。
 *
 * 与 `danmaku/matching.ts` 复用同一套标题匹配（Levenshtein + 别名），
 * 因为「BGM 的番剧名」到「Jellyfin 的文件夹名」的差异与弹幕源完全同类问题。
 */

import { prisma } from "@/lib/prisma";
import {
  MatchMethod,
  levenshteinDistance,
  titlesMatch,
  type MatchMethodValue,
} from "@/lib/danmaku/matching";
import {
  JellyfinError,
  authenticate,
  buildImageUrl,
  isLoopbackUrl,
  buildStreamUrl,
  listEpisodes,
  normalizeBaseUrl,
  probeServer,
  searchSeries,
  ticksToMs,
  type JellyfinItem,
} from "./jellyfin";

/** 对外暴露的连接信息 —— **不含 token**。 */
export interface JellyfinConnectionView {
  id: string;
  name: string;
  baseUrl: string;
  remoteUserName: string;
  serverName: string | null;
  serverVersion: string | null;
  allowPrivateHost: boolean;
  lastCheckedAt: string | null;
  createdAt: string;
  /**
   * 配置警告。当前用于环回地址 —— 「只能本机访问」的地址会导致
   * 除服务器本人外**所有用户都播不了**，必须显著提示。
   */
  warning: string | null;
}

interface ConnectionRow {
  id: string;
  userId: string;
  name: string;
  baseUrl: string;
  accessToken: string;
  remoteUserId: string;
  remoteUserName: string;
  serverName: string | null;
  serverVersion: string | null;
  allowPrivateHost: boolean;
  lastCheckedAt: Date | null;
  createdAt: Date;
}

function toView(row: ConnectionRow): JellyfinConnectionView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    remoteUserName: row.remoteUserName,
    serverName: row.serverName,
    serverVersion: row.serverVersion,
    allowPrivateHost: row.allowPrivateHost,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    warning: isLoopbackUrl(row.baseUrl)
      ? "该地址是 localhost，只有服务器本机能播放。请改用服务器在局域网中的地址（例如 http://10.0.0.5:8096），否则其他用户打开页面会播不了。"
      : null,
  };
}

export async function listConnections(userId: string): Promise<JellyfinConnectionView[]> {
  const rows = await prisma.jellyfinConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

export interface ConnectInput {
  userId: string;
  name: string;
  baseUrl: string;
  username: string;
  password: string;
  allowPrivateHost?: boolean;
}

/**
 * 连接一台 Jellyfin 服务器。
 *
 * 先探测公开信息再做登录 —— 这样「地址打不通」与「密码错」能给出不同提示，
 * 而不是笼统地失败。
 */
export async function connectJellyfin(input: ConnectInput): Promise<JellyfinConnectionView> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (baseUrl === null) throw new JellyfinError("服务器地址格式不合法");

  const allowPrivateHost = input.allowPrivateHost ?? true;

  // 1) 连通性与身份确认
  const info = await probeServer(baseUrl, { allowPrivateHost });
  if (info.StartupWizardCompleted === false) {
    throw new JellyfinError(
      "该 Jellyfin 服务器尚未完成初始化向导，请先在它的网页端完成设置",
    );
  }

  // 2) 登录（密码只在这一次请求中使用，不落库）
  const auth = await authenticate(baseUrl, input.username, input.password, { allowPrivateHost });

  const row = await prisma.jellyfinConnection.upsert({
    where: { userId_baseUrl: { userId: input.userId, baseUrl } },
    create: {
      userId: input.userId,
      name: input.name,
      baseUrl,
      accessToken: auth.accessToken,
      remoteUserId: auth.userId,
      remoteUserName: auth.userName,
      serverName: info.ServerName,
      serverVersion: info.Version,
      allowPrivateHost,
      lastCheckedAt: new Date(),
    },
    update: {
      name: input.name,
      accessToken: auth.accessToken,
      remoteUserId: auth.userId,
      remoteUserName: auth.userName,
      serverName: info.ServerName,
      serverVersion: info.Version,
      allowPrivateHost,
      lastCheckedAt: new Date(),
    },
  });

  return toView(row);
}

export async function disconnectJellyfin(userId: string, id: string): Promise<void> {
  await prisma.jellyfinConnection.deleteMany({ where: { id, userId } });
}

/**
 * 取连接（含 token）。**仅供服务端内部使用** —— 调用方不得把它回显给客户端。
 */
async function requireConnection(userId: string, id: string): Promise<ConnectionRow> {
  const row = await prisma.jellyfinConnection.findFirst({ where: { id, userId } });
  if (!row) throw new JellyfinError("连接不存在");
  return row;
}

/* ------------------------------------------------------------------ *
 * 匹配与查找
 * ------------------------------------------------------------------ */

/** 某个条目在一台服务器上的匹配结果。 */
export interface JellyfinMatch {
  connectionId: string;
  connectionName: string;
  /** 匹配到的系列；null 表示没找到 */
  series: { id: string; name: string; year: number | null; posterUrl: string } | null;
  matchMethod: MatchMethodValue;
  /** 模糊匹配的距离，越小越像 */
  distance: number | null;
  error: string | null;
}

/**
 * 把 BGM 条目匹配到各台 Jellyfin 服务器上的系列。
 *
 * 匹配策略：用条目名与全部别名逐一搜索，再按标题相似度择优。
 * 这一步**必然有误差** —— 媒体库的命名千差万别（含字幕组、分辨率、季数后缀），
 * 因此结果里带 `matchMethod` 与 `distance` 让调用方能标注「精确/模糊」。
 */
export async function matchSubjectOnConnections(
  userId: string,
  subject: { name: string; nameCn: string | null; aliases?: string[] },
): Promise<JellyfinMatch[]> {
  const connections = await prisma.jellyfinConnection.findMany({ where: { userId } });
  const names = [subject.nameCn, subject.name, ...(subject.aliases ?? [])].filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );

  const results: JellyfinMatch[] = [];

  for (const connection of connections) {
    const base = {
      connectionId: connection.id,
      connectionName: connection.name,
    };

    try {
      // 逐个名字搜索并累积候选（同一部番在不同库里的命名差异很大）
      const candidates: JellyfinItem[] = [];
      for (const name of names.slice(0, 3)) {
        const found = await searchSeries(
          connection.baseUrl,
          connection.accessToken,
          connection.remoteUserId,
          name,
          { limit: 10, allowPrivateHost: connection.allowPrivateHost },
        );
        candidates.push(...found);
      }

      // 去重
      const unique = new Map<string, JellyfinItem>();
      for (const item of candidates) unique.set(item.Id, item);

      if (unique.size === 0) {
        results.push({ ...base, series: null, matchMethod: MatchMethod.NoMatch, distance: null, error: null });
        continue;
      }

      // 择优：先找标题精确相等的；没有则取编辑距离最小的，并标注为模糊匹配。
      // 媒体库命名常带字幕组/分辨率/季数后缀，精确相等命中率不高，所以模糊档必须有。
      const scored = [...unique.values()].map((item) => {
        const exact = names.some((name) => titlesMatch(item.Name, name));
        const distance = Math.min(
          ...names.map((name) => levenshteinDistance(item.Name, name)),
        );
        return { item, exact, distance };
      });

      scored.sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance);
      const best = scored[0];

      results.push({
        ...base,
        series: {
          id: best.item.Id,
          name: best.item.Name,
          year: best.item.ProductionYear ?? null,
          posterUrl: buildImageUrl(connection.baseUrl, best.item.Id),
        },
        matchMethod: best.exact ? MatchMethod.ExactName : MatchMethod.Fuzzy,
        distance: best.exact ? null : best.distance,
        error: null,
      });
    } catch (error) {
      results.push({
        ...base,
        series: null,
        matchMethod: MatchMethod.NoMatch,
        distance: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/** 可播放的剧集。 */
export interface PlayableEpisode {
  id: string;
  name: string;
  /** 季号 / 集号 */
  season: number | null;
  episode: number | null;
  durationMs: number | null;
  played: boolean;
  positionMs: number;
  /** **直连**播放地址（含用户自己的 token，不经本服务代理） */
  streamUrl: string;
  /** 从第几毫秒续播 */
  resumeFromMs: number;
}

/** 列出某系列在此服务器上的剧集。 */
export async function listPlayableEpisodes(
  userId: string,
  connectionId: string,
  seriesId: string,
): Promise<PlayableEpisode[]> {
  const connection = await requireConnection(userId, connectionId);

  const items = await listEpisodes(
    connection.baseUrl,
    connection.accessToken,
    connection.remoteUserId,
    seriesId,
    { allowPrivateHost: connection.allowPrivateHost },
  );

  return items
    .map((item) => {
      const positionMs = ticksToMs(item.UserData?.PlaybackPositionTicks) ?? 0;
      const durationMs = ticksToMs(item.RunTimeTicks);
      // 已看完或几乎看完的不续播
      const nearlyDone = durationMs !== null && durationMs - positionMs < 30_000;
      return {
        id: item.Id,
        name: item.Name,
        season: item.ParentIndexNumber ?? null,
        episode: item.IndexNumber ?? null,
        durationMs,
        played: item.UserData?.Played === true,
        positionMs,
        streamUrl: buildStreamUrl(connection.baseUrl, item.Id, connection.accessToken),
        resumeFromMs: nearlyDone ? 0 : positionMs,
      };
    })
    .sort((a, b) => (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0));
}

/** 重新探测连接状态（不重新登录，只测可达性）。 */
export async function refreshConnection(
  userId: string,
  id: string,
): Promise<{ ok: boolean; serverName?: string; version?: string; error?: string }> {
  const connection = await requireConnection(userId, id);
  try {
    const info = await probeServer(connection.baseUrl, {
      allowPrivateHost: connection.allowPrivateHost,
    });
    await prisma.jellyfinConnection.update({
      where: { id },
      data: {
        serverName: info.ServerName,
        serverVersion: info.Version,
        lastCheckedAt: new Date(),
      },
    });
    return { ok: true, serverName: info.ServerName, version: info.Version };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
