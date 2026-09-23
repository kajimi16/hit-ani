import { NextResponse } from "next/server";
import { z } from "zod";
import {
  BgmNotBoundError,
  BgmTokenExpiredError,
  getFreshBgmAccessToken,
  unbindBgmAccount,
} from "@/lib/auth/bgm-oauth";
import { unbindQqAccount } from "@/lib/auth/qq-oauth";
import { requireSessionUser } from "@/lib/auth/session";
import { getImportJob, runImportTick, startImportJob } from "@/lib/bgm/import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/library/import — 当前导入进度。
 *
 * 这个端点存在的意义：导入需要数分钟、上千次上游请求，必须让客户端能问
 * 「现在到哪了」，而不是盯着一个永不结束的「导入中」。
 */
export async function GET() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const job = await getImportJob(user.id);
  return NextResponse.json({ job });
}

const startSchema = z.object({
  /** true = 丢弃当前进度，重新抓取上游快照 */
  restart: z.boolean().optional(),
});

/**
 * POST /api/library/import — 启动或推进导入。
 *
 * - 无任务，或 `restart: true`：抓取上游快照，返回初始进度
 * - 已有进行中的任务：推进一批，返回新进度
 * - 任务已完成：原样返回
 *
 * 客户端循环调用本端点直至 `status === "done"`，从而把一次长任务拆成多个有界请求。
 */
export async function POST(request: Request) {
  const user = await requireSessionUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const body = await request
    .json()
    .then((value) => startSchema.parse(value))
    .catch(() => ({ restart: false }) satisfies z.infer<typeof startSchema>);

  let accessToken: string;
  let bgmUsername: string;
  try {
    ({ accessToken, bgmUsername } = await getFreshBgmAccessToken(
      user.id,
      new URL(request.url).origin,
    ));
  } catch (error) {
    if (error instanceof BgmTokenExpiredError || error instanceof BgmNotBoundError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  const existing = await getImportJob(user.id);

  // 已完成的任务必须幂等：重复 POST 只回读状态，**不得**悄悄重跑。
  // 重跑只有显式 `restart: true` 才允许 —— 否则任何多余的轮询都会把进度清零。
  if (existing && existing.status === "done" && body.restart !== true) {
    return NextResponse.json({ ok: true, bgmUsername, job: existing });
  }

  try {
    const job =
      body.restart === true || existing === null
        ? await startImportJob(user.id, { username: bgmUsername, accessToken })
        : await runImportTick(user.id, accessToken);

    return NextResponse.json({ ok: true, bgmUsername, job });
  } catch (error) {
    // 把失败写进任务状态，让下一次 GET 也能看到原因，而不是只丢给这一次响应
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[bgm-import] userId=${user.id} 推进失败：${message}`);

    return NextResponse.json(
      { error: "导入推进失败", detail: message, job: await getImportJob(user.id) },
      { status: 502 },
    );
  }
}

/** DELETE /api/library/import?target=bgm|qq — 解除绑定（同时清理导入任务）。 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const target = new URL(request.url).searchParams.get("target");
  if (target === "bgm") {
    await unbindBgmAccount(user.id);
    return NextResponse.json({ ok: true, target });
  }
  if (target === "qq") {
    await unbindQqAccount(user.id);
    return NextResponse.json({ ok: true, target });
  }
  return NextResponse.json({ error: "target 只能是 bgm 或 qq" }, { status: 400 });
}
