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
 * 媒体源管理。
 *
 * ⚠️ 权限说明：当前**任何登录用户**都可增删改源。校内自用场景下这是可接受的简化，
 * 但公开部署前必须加管理员角色 —— 否则任何人都能配置一个指向内网或恶意站点的源。
 * （SSRF 防护已挡住内网，但源的增删改本身仍应受限。）
 */

/** GET /api/media/sources — 列出已配置的源与可用预设。 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

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
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

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
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

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
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

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
