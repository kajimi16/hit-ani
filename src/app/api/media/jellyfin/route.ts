import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import {
  connectJellyfin,
  disconnectJellyfin,
  listConnections,
  refreshConnection,
} from "@/lib/media/jellyfin-service";
import { probeServer } from "@/lib/media/jellyfin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Jellyfin / Emby 连接管理。
 *
 * ⚠️ 安全要点：响应里**永远不含 accessToken**（见 `JellyfinConnectionView`）。
 * token 只在服务端用于调用媒体库 API 与生成直连播放地址。
 */

/** GET /api/media/jellyfin — 列出连接。 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  return NextResponse.json({ connections: await listConnections(user.id) });
}

const probeSchema = z.object({
  baseUrl: z.string().min(1).max(2048),
});

/** POST /api/media/jellyfin?action=probe — 测试地址是否可达（无需凭据）。 */
export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const action = new URL(request.url).searchParams.get("action");

  if (action === "probe") {
    let body;
    try {
      body = probeSchema.parse(await request.json());
    } catch {
      return NextResponse.json({ error: "缺少 baseUrl" }, { status: 400 });
    }
    try {
      const info = await probeServer(body.baseUrl, { allowPrivateHost: true });
      return NextResponse.json({
        ok: true,
        serverName: info.ServerName,
        version: info.Version,
        startupWizardCompleted: info.StartupWizardCompleted,
      });
    } catch (error) {
      return NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: "未知的 action" }, { status: 400 });
}

const connectSchema = z.object({
  name: z.string().min(1).max(64),
  /** 服务端访问地址（容器部署时是内部服务名） */
  baseUrl: z.string().min(1).max(2048),
  /**
   * 浏览器侧访问地址。容器部署时必填 —— 服务端走内部服务名，
   * 而学生浏览器解析不了它。留空则与 baseUrl 相同。
   */
  publicBaseUrl: z.string().max(2048).nullish(),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
  allowPrivateHost: z.boolean().optional(),
});

/** PUT /api/media/jellyfin — 新建连接。 */
export async function PUT(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body;
  try {
    body = connectSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json(
      {
        error: "参数不合法",
        details:
          error instanceof z.ZodError
            ? error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
              }))
            : String(error),
      },
      { status: 400 },
    );
  }

  try {
    const connection = await connectJellyfin({
      userId: user.id,
      name: body.name,
      baseUrl: body.baseUrl,
      publicBaseUrl: body.publicBaseUrl ?? null,
      username: body.username,
      password: body.password,
      allowPrivateHost: body.allowPrivateHost,
    });
    return NextResponse.json({ connection }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/** DELETE /api/media/jellyfin?id= — 断开连接。 */
export async function DELETE(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  await disconnectJellyfin(user.id, id);
  return NextResponse.json({ ok: true });
}

/** PATCH /api/media/jellyfin?id= — 重新探测连接状态。 */
export async function PATCH(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  return NextResponse.json(await refreshConnection(user.id, id));
}
