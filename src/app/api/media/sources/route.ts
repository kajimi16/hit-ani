import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/session";
import {
  createSource,
  deleteSource,
  listSources,
  updateSource,
} from "@/lib/media/service";
import { SOURCE_PRESETS } from "@/lib/media/source-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 媒体源管理（**仅管理员**）。
 *
 * 抓取源是**全站共享**配置：改一个源会影响所有人的搜索结果，
 * 而且 SSRF 防护虽挡住内网，配置本身仍可能被用来骚扰第三方站点。
 * 因此读也限管理员 —— 普通用户不需要、也不应该看到这类基础设施配置。
 *
 * 用户自己的 Jellyfin/Emby 连接**不在这里**（那是个人配置，见 /settings）。
 */

/** 统一的权限检查：未登录 401，非管理员 403。 */
async function requireAdmin(): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  const user = await requireSessionUser().catch(() => null);
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  }
  if (!user.isAdmin) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "只有管理员可以管理抓取源。如需配置你自己的媒体服务器，请到「设置」页面。" },
        { status: 403 },
      ),
    };
  }
  return { ok: true, userId: user.id };
}

/** GET /api/media/sources — 列出已配置的源与可用预设。 */
export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const sources = await listSources();
  return NextResponse.json({ sources, presets: SOURCE_PRESETS });
}

const createSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).nullish(),
  factory: z.string().min(1).max(32),
  config: z.unknown(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
});

/** POST /api/media/sources — 新建源。 */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = createSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: "参数不合法", details: formatZod(error) }, { status: 400 });
  }

  try {
    const source = await createSource({
      name: body.name,
      description: body.description ?? null,
      factory: body.factory,
      config: body.config,
      enabled: body.enabled,
      priority: body.priority,
    });
    return NextResponse.json({ source }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

const updateSchema = createSchema.partial();

/** PUT /api/media/sources?id= — 更新源。 */
export async function PUT(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  let body;
  try {
    body = updateSchema.parse(await request.json());
  } catch (error) {
    return NextResponse.json({ error: "参数不合法", details: formatZod(error) }, { status: 400 });
  }

  try {
    const source = await updateSource(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.factory !== undefined ? { factory: body.factory } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
    });
    return NextResponse.json({ source });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

/** DELETE /api/media/sources?id= — 删除源。 */
export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "缺少 id" }, { status: 400 });

  await deleteSource(id);
  return NextResponse.json({ ok: true });
}

function formatZod(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
  }
  return error instanceof Error ? error.message : String(error);
}
