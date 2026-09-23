import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 健康检查。
 *
 * 同时验证两件事，因为它们的故障表现完全不同：
 * 1. **进程存活** —— 容器没崩
 * 2. **数据库连通** —— 进程活着但连不上库时，接口全 500，健康检查却会假报正常
 *
 * 因此这里真的打一次数据库。用 `SELECT 1` 而不是 COUNT 任何表 ——
 * 健康检查要足够轻，不能被业务数据规模拖慢。
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        db: "unreachable",
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ok: true,
    db: "ok",
    /** 数据库往返耗时，便于观察连接池是否吃紧 */
    dbLatencyMs: Date.now() - startedAt,
    uptimeSeconds: Math.round(process.uptime()),
  });
}
