/**
 * 弹幕 WebSocket 网关 —— 独立常驻进程。
 *
 * 为什么不放在 Next.js route handler：
 * WebSocket 是长连接 + 常驻内存广播，Serverless 函数有时长上限且无持久连接。
 * 因此本进程必须独立部署（Railway / Render / VPS），与 SSR 应用分离。
 *
 * 启动：`npm run gateway`（默认 :3002，可用 DANMAKU_GATEWAY_PORT 覆盖）
 * 协议：`ws://<host>/danmaku/room/<episodeId>?schoolOnly=true`
 *
 * 客户端 → 服务端：
 *   { "type": "send", "playTimeMs": 12345, "text": "233", "color": 16777215, "location": 0 }
 *   { "type": "ping" }
 * 服务端 → 客户端：
 *   { "type": "repopulate", "list": DanmakuDto[], "playTimeMs": 0 }   // 加入房间时的首屏
 *   { "type": "add", "danmaku": DanmakuDto }                          // 增量广播
 *   { "type": "error", "message": string }
 *   { "type": "pong" }
 *
 * 事件语义对齐 Animeko 的 `DanmakuEvent.Add` / `DanmakuEvent.Repopulate`。
 */

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { validateSendInput } from "@/lib/danmaku/engine";
import { isBlocked } from "@/lib/danmaku/filter";
import { danmakuRateLimiter } from "@/lib/danmaku/rate-limit";
import { createDanmaku, listDanmaku } from "@/lib/danmaku/repository";
import { DANMAKU_LIMITS, type DanmakuDto } from "@/lib/danmaku/types";
import { prisma } from "@/lib/prisma";

const PORT = Number(process.env.DANMAKU_GATEWAY_PORT ?? 3002);
/** 房间首屏回填的时间窗，避免一次性把整集拖回来。 */
const REPOPULATE_WINDOW_MS = 3 * 60 * 1000;
const MAX_TEXT_LENGTH = DANMAKU_LIMITS.maxTextLength;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

interface Client {
  socket: WebSocket;
  episodeId: number;
  schoolOnly: boolean;
  schoolId: string;
  userId: string;
  alive: boolean;
}

/** episodeId → 已连接的客户端。 */
const rooms = new Map<number, Set<Client>>();

function roomOf(episodeId: number): Set<Client> {
  let room = rooms.get(episodeId);
  if (!room) {
    room = new Set();
    rooms.set(episodeId, room);
  }
  return room;
}

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

interface ResolvedSession {
  userId: string;
  schoolId: string;
}

/** WS 无法用 next/headers 的 cookies()，直接从 upgrade 请求头解析。 */
async function resolveSession(cookieHeader: string | undefined): Promise<ResolvedSession | null> {
  const cookies = parseCookies(cookieHeader);
  const userId = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, schoolId: true },
  });
  return user ? { userId: user.id, schoolId: user.schoolId } : null;
}

const httpServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      service: "hit-ani-danmaku-gateway",
      rooms: rooms.size,
      connections: [...rooms.values()].reduce((sum, room) => sum + room.size, 0),
    }),
  );
});

const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const match = /^\/danmaku\/room\/(\d+)$/.exec(url.pathname);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const episodeId = Number(match[1]);
  const schoolOnly = ["true", "1"].includes(url.searchParams.get("schoolOnly") ?? "false");

  resolveSession(request.headers.cookie)
    .then((session) => {
      if (!session) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        void onConnection(ws, episodeId, schoolOnly, session);
      });
    })
    .catch(() => {
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    });
});

async function onConnection(
  socket: WebSocket,
  episodeId: number,
  schoolOnly: boolean,
  session: ResolvedSession,
): Promise<void> {
  const client: Client = {
    socket,
    episodeId,
    schoolOnly,
    schoolId: session.schoolId,
    userId: session.userId,
    alive: true,
  };
  roomOf(episodeId).add(client);

  // 首屏回填：优先附近时间窗；该集弹幕少时直接给全量
  const nearby = await listDanmaku({
    episodeId,
    fromMs: 0,
    toMs: REPOPULATE_WINDOW_MS,
    schoolOnly,
    schoolId: client.schoolId,
    limit: DANMAKU_LIMITS.defaultLimit,
  });

  send(socket, {
    type: "repopulate",
    list: nearby,
    playTimeMs: 0,
    schoolOnly,
  } satisfies RoomPayload);

  socket.on("message", (raw) => {
    void handleMessage(client, raw.toString());
  });

  socket.on("pong", () => {
    client.alive = true;
  });

  socket.on("close", () => {
    const room = rooms.get(episodeId);
    room?.delete(client);
    if (room && room.size === 0) rooms.delete(episodeId);
  });

  socket.on("error", () => {
    socket.close();
  });
}

interface RoomPayload {
  type: string;
  list?: DanmakuDto[];
  danmaku?: DanmakuDto;
  playTimeMs?: number;
  schoolOnly?: boolean;
  message?: string;
}

async function handleMessage(client: Client, raw: string): Promise<void> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    send(client.socket, { type: "error", message: "消息不是合法 JSON" });
    return;
  }

  if (parsed.type === "ping") {
    send(client.socket, { type: "pong" });
    return;
  }

  if (parsed.type !== "send") {
    send(client.socket, { type: "error", message: `未知消息类型: ${String(parsed.type)}` });
    return;
  }

  const input = {
    episodeId: client.episodeId,
    playTimeMs: Number(parsed.playTimeMs),
    text: String(parsed.text ?? ""),
    color: parsed.color === undefined ? undefined : Number(parsed.color),
    location: parsed.location === undefined ? undefined : Number(parsed.location),
  };

  if (input.text.length > MAX_TEXT_LENGTH * 4) {
    send(client.socket, { type: "error", message: "弹幕过长" });
    return;
  }

  const errors = validateSendInput(input as never);
  if (errors.length > 0) {
    send(client.socket, { type: "error", message: errors[0].message });
    return;
  }

  // 与 REST 路径同样的屏蔽词校验 —— WS 是另一条写入通道，
  // 只挡 REST 等于留了个绕过口子。
  if (isBlocked(input.text)) {
    send(client.socket, { type: "error", message: "弹幕包含被屏蔽的内容，请修改后重试" });
    return;
  }

  const decision = danmakuRateLimiter.consume(client.userId);
  if (!decision.allowed) {
    send(client.socket, {
      type: "error",
      message: `发送过于频繁，请 ${Math.ceil(decision.retryAfterMs / 1000)} 秒后重试`,
    });
    return;
  }

  try {
    const { danmaku } = await createDanmaku(client.userId, input as never);

    // 房间内回显给所有人；「只看本校」房间只投递给同校连接
    const target = rooms.get(client.episodeId);
    if (target) {
      const message = JSON.stringify({ type: "add", danmaku } satisfies RoomPayload);
      for (const peer of target) {
        if (peer.socket.readyState !== peer.socket.OPEN) continue;
        if (peer.schoolOnly && peer.schoolId !== danmaku.schoolId) continue;
        peer.socket.send(message);
      }
    }
  } catch (error) {
    send(client.socket, {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 遍历所有已连接客户端。房间是动态增删的，故显式展开而非依赖 Array.flat 的类型推导。 */
function allClients(): Client[] {
  const result: Client[] = [];
  for (const room of rooms.values()) {
    for (const client of room) result.push(client);
  }
  return result;
}

/** 心跳：清理半开连接，避免房间 Set 泄漏。 */
const heartbeat = setInterval(() => {
  for (const client of allClients()) {
    if (!client.alive) {
      client.socket.terminate();
      continue;
    }
    client.alive = false;
    client.socket.ping();
  }
  danmakuRateLimiter.prune();
}, PRUNE_INTERVAL_MS);

const shutdown = () => {
  clearInterval(heartbeat);
  for (const client of allClients()) client.socket.close(1001, "server shutdown");
  wss.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

httpServer.listen(PORT, () => {
  console.log(`[danmaku-gateway] listening on :${PORT}`);
});
