/**
 * 端到端冒烟测试。
 *
 * 覆盖真实链路（不是单测）：
 *   1. Bangumi 只读接口直连（`POST /v0/search/subjects`）—— 验证 api.bgm.tv 可达且 schema 未漂移
 *   2. 注册 → 会话 Cookie
 *   3. 弹幕 REST：全体拉取 / 本校筛选（必须排除外校）→ 发送 → 再拉取（必须包含刚发的）
 *   4. 弹幕 WebSocket：两条连接实时收到广播；`schoolOnly` 连接不得收到外校弹幕
 *   5. 评论：发布 → 发布 → 全体/本校筛选
 *
 * 前置：`npm run db:seed` 已执行（提供 hit / demo-other 两所学校与 episode 8 的测试弹幕）。
 * 运行：先启动 `npm run dev` 与 `npm run gateway`，再执行 `npm run smoke`
 *      可用 BASE_URL / WS_URL 覆盖地址。
 */

import { WebSocket } from "ws";
import { prisma } from "@/lib/prisma";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const WS_URL = process.env.WS_URL ?? "ws://localhost:3102";
// 与 prisma/seed.ts 的 SEED_EPISODE_ID 保持一致（必须是真实 BGM episode id）
const SEED_EPISODE_ID = Number(process.env.SEED_EPISODE_ID ?? 522);
const SEED_SUBJECT_ID = Number(process.env.SEED_SUBJECT_ID ?? 8);
const PASSWORD = "hitani-dev-2026";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  checks += 1;
  if (condition) {
    console.log(`  ✔ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✘ ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

interface Session {
  cookie: string;
  schoolId: string;
  nickname: string;
  /** 是否已绑定 Bangumi —— 决定写操作会不会镜像到真实上游。 */
  bgmBound: boolean;
}

async function login(identifier: string): Promise<Session> {
  const response = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`登录失败 ${identifier}: ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  const body = (await response.json()) as { user: { schoolId: string; nickname: string } };

  // 再读一次会话拿绑定状态（登录响应本身不含该字段）
  const sessionInfo = await fetch(`${BASE_URL}/api/auth/login`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  })
    .then((r) => r.json() as Promise<{ user: { bgmBound?: boolean } | null }>)
    .catch(() => ({ user: null }));

  return {
    cookie,
    schoolId: body.user.schoolId,
    nickname: body.user.nickname,
    bgmBound: sessionInfo.user?.bgmBound === true,
  };
}

async function getDanmaku(session: Session | null, schoolOnly: boolean) {
  const url = new URL("/api/danmaku", BASE_URL);
  url.searchParams.set("episodeId", String(SEED_EPISODE_ID));
  url.searchParams.set("limit", "2000");
  if (schoolOnly) url.searchParams.set("schoolOnly", "true");

  const response = await fetch(url, {
    headers: session ? { Cookie: session.cookie } : {},
    cache: "no-store",
  });
  const body = (await response.json()) as {
    data?: { id: string; schoolId: string; text: string }[];
    total?: number;
    schoolTotal?: number;
    error?: string;
  };
  return { status: response.status, body };
}

async function postDanmaku(session: Session, text: string, playTimeMs = 1000) {
  const response = await fetch(`${BASE_URL}/api/danmaku`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: session.cookie },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, playTimeMs, text, location: 0 }),
  });
  return { status: response.status, body: await response.json() };
}

/** 打开一个 WS 房间连接，收集监听到的弹幕。 */
function openRoom(session: Session, schoolOnly: boolean) {
  const url = new URL(`${WS_URL}/danmaku/room/${SEED_EPISODE_ID}`);
  if (schoolOnly) url.searchParams.set("schoolOnly", "true");

  const socket = new WebSocket(url, { headers: { Cookie: session.cookie } });
  const received: { text: string; schoolId: string }[] = [];
  let repopulated: { text: string; schoolId: string }[] | null = null;

  socket.on("message", (raw) => {
    const payload = JSON.parse(raw.toString()) as {
      type: string;
      list?: { text: string; schoolId: string }[];
      danmaku?: { text: string; schoolId: string };
    };
    if (payload.type === "repopulate" && payload.list) repopulated = payload.list;
    if (payload.type === "add" && payload.danmaku) received.push(payload.danmaku);
  });

  return {
    socket,
    received,
    get repopulated() {
      return repopulated;
    },
    waitOpen: new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
      setTimeout(() => reject(new Error("WS 连接超时")), 8000);
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * 依赖上游 Bangumi 的请求重试一次。
 *
 * 冒烟会连续打出多个 BGM 请求，上游偶发超时/限流不是本项目缺陷 —— 但静默重试会掩盖真实回归，
 * 因此仅在 502（上游错误）时重试，且把最终失败的原始 detail 一并带出。
 */
async function fetchWithUpstreamRetry(
  url: string,
  init: RequestInit = {},
): Promise<{ response: Response; text: string }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, { cache: "no-store", ...init });
    const text = await response.text();
    if (response.status !== 502 || attempt === 1) return { response, text };
    console.warn(`    （上游返回 502，1 秒后重试：${url}）`);
    await sleep(1000);
  }
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  section("0. 前置检查");
  const health = await fetch(`${BASE_URL}/api/search?keyword=魔法`, { cache: "no-store" });
  check("Next.js 服务可达", health.ok, health.status);
  await health.body?.cancel();

  const gatewayHealth = await fetch(WS_URL.replace("ws://", "http://"), {
    cache: "no-store",
  }).catch(() => null);
  check("弹幕网关 HTTP 健康检查可达", gatewayHealth?.ok === true);

  // ---------------------------------------------------------------- BGM 直连
  section("1. Bangumi API 直连（验证 schema 未漂移）");
  const bgmResponse = await fetchWithUpstreamRetry(
    `${BASE_URL}/api/search?keyword=${encodeURIComponent("魔法少女")}&limit=3`,
  );
  const bgm = JSON.parse(bgmResponse.text) as {
    total?: number;
    data?: { id: number; name: string }[];
    error?: string;
    detail?: string;
  };
  check(
    "搜索返回 200",
    bgmResponse.response.ok,
    `${bgm.error ?? ""} ${bgm.detail ?? ""}`.trim(),
  );
  check("搜索结果非空", (bgm.data?.length ?? 0) > 0, bgm);
  check("总数 > 0", (bgm.total ?? 0) > 0, bgm.total);

  const detailResponse = await fetch(`${BASE_URL}/api/subjects/${SEED_SUBJECT_ID}`, {
    cache: "no-store",
  });
  const detail = (await detailResponse.json()) as {
    subject?: { id: number };
    episodes?: { id: number }[];
  };
  check("条目详情返回 200", detailResponse.ok);
  check(
    "条目含章节（弹幕挂载点存在）",
    (detail.episodes?.length ?? 0) > 0,
    detail.episodes?.length,
  );

  // ---------------------------------------------------------------- 会话
  section("2. 注册与登录");
  const teacherEmail = `smoke-${Date.now()}@hit.edu.cn`;
  const registerResponse = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: teacherEmail,
      password: PASSWORD,
      nickname: "冒烟测试员",
      studentNo: `SMOKE-${Date.now()}`,
    }),
  });
  const registered = (await registerResponse.json()) as {
    user?: { schoolId: string };
    error?: string;
  };
  check("本校域名注册成功", registerResponse.status === 201, registered.error);

  // 进度测试必须用**未绑定 BGM** 的专用账号。
  //
  // 原因：`PUT /api/progress` 在 `user.bgmBound` 时会把进度镜像写回真实 BGM 账号。
  // 种子账号 alice 可能已被开发者绑定 BGM —— 用它跑回归会**每次污染真实观看进度**
  // （而且收藏数不变，只看收藏总数根本发现不了）。
  // 刚注册的账号确定未绑定，用它做写操作即可完全避免该风险。
  const unbound = await login(teacherEmail);
  check(
    "新建账号未绑定 BGM（进度测试不会写入真实上游）",
    unbound.bgmBound === false,
    { bgmBound: unbound.bgmBound },
  );

  const outsiderResponse = await fetch(`${BASE_URL}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `outsider-${Date.now()}@gmail.com`,
      password: PASSWORD,
      nickname: "外校人",
    }),
  });
  check("非白名单域名注册被拒绝（403）", outsiderResponse.status === 403, outsiderResponse.status);

  const alice = await login("alice@hit.edu.cn");
  const bob = await login("bob@example.edu");
  check("本校种子账号登录成功", alice.schoolId === "hit", alice);
  check("外校种子账号登录成功", bob.schoolId === "demo-other", bob);

  // ---------------------------------------------------------------- 弹幕 REST
  section("3. 弹幕 REST：拉取 / 本校筛选 / 发送");
  const allBefore = await getDanmaku(alice, false);
  check("全体拉取成功", allBefore.status === 200, allBefore.body.error);
  check("全体弹幕非空", (allBefore.body.data?.length ?? 0) > 0);

  const schoolBefore = await getDanmaku(alice, true);
  check("本校拉取成功", schoolBefore.status === 200, schoolBefore.body.error);
  const schoolIds = new Set(schoolBefore.body.data?.map((d) => d.schoolId));
  check(
    "本校筛选只返回 hit 学校的弹幕",
    schoolIds.size > 0 && [...schoolIds].every((id) => id === "hit"),
    [...schoolIds],
  );
  check(
    "本校筛选确实排除了外校弹幕",
    (schoolBefore.body.data?.length ?? 0) < (allBefore.body.data?.length ?? 0),
    { school: schoolBefore.body.data?.length, all: allBefore.body.data?.length },
  );

  const unauthSchool = await getDanmaku(null, true);
  check("未登录时本校筛选要求登录（401）", unauthSchool.status === 401, unauthSchool.status);

  const aliceText = `冒烟-本校-${Date.now()}`;
  const sentByAlice = await postDanmaku(alice, aliceText, 11_000);
  check("本校用户发送弹幕成功", sentByAlice.status === 201, sentByAlice.body);

  const afterSend = await getDanmaku(alice, false);
  check(
    "刚发送的弹幕可被拉取到",
    (afterSend.body.data ?? []).some((d) => d.text === aliceText),
  );

  const invalid = await fetch(`${BASE_URL}/api/danmaku`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: alice.cookie },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, playTimeMs: -5, text: "" }),
  });
  check("非法弹幕被拒绝（400）", invalid.status === 400, invalid.status);
  await invalid.body?.cancel();

  const anonymous = await fetch(`${BASE_URL}/api/danmaku`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, playTimeMs: 0, text: "匿名" }),
  });
  check("未登录发送被拒绝（401）", anonymous.status === 401, anonymous.status);
  await anonymous.body?.cancel();

  // ---------------------------------------------------------------- WebSocket
  section("4. 弹幕 WebSocket：实时广播 + 校内投递隔离");
  const aliceRoom = openRoom(alice, false);
  const bobRoom = openRoom(bob, false);
  const bobSchoolRoom = openRoom(bob, true);

  try {
    await Promise.all([aliceRoom.waitOpen, bobRoom.waitOpen, bobSchoolRoom.waitOpen]);
    check("三条 WS 连接全部建立", true);
    await sleep(600);

    check("加入房间时收到首屏回填（repopulate）", aliceRoom.repopulated !== null);
    check(
      "外校的 schoolOnly 房间回填只含外校弹幕",
      (bobSchoolRoom.repopulated ?? []).every((d) => d.schoolId === "demo-other"),
      bobSchoolRoom.repopulated,
    );

    const wsText = `冒烟-WS-${Date.now()}`;
    const response = await fetch(`${BASE_URL}/api/danmaku`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: alice.cookie },
      body: JSON.stringify({ episodeId: SEED_EPISODE_ID, playTimeMs: 12_000, text: wsText }),
    });
    check("通过 REST 发送供 WS 广播的弹幕", response.status === 201);
    await response.body?.cancel();

    // 直接经 WS 发送，验证 WS 写入路径
    const wsSendText = `冒烟-WS发送-${Date.now()}`;
    aliceRoom.socket.send(
      JSON.stringify({ type: "send", playTimeMs: 13_000, text: wsSendText, location: 0 }),
    );

    await sleep(1200);

    check(
      "外校连接收到本校弹幕（非 schoolOnly 房间应收到全部）",
      bobRoom.received.some((d) => d.text === wsText || d.text === wsSendText),
      bobRoom.received.map((d) => d.text),
    );
    check(
      "外校的 schoolOnly 房间未收到本校弹幕（隔离生效）",
      !bobSchoolRoom.received.some((d) => d.schoolId === "hit"),
      bobSchoolRoom.received.map((d) => d.schoolId),
    );
    check(
      "经 WS 发送的弹幕已入库",
      (await getDanmaku(alice, false)).body.data?.some((d) => d.text === wsSendText) === true,
    );
  } finally {
    aliceRoom.socket.close();
    bobRoom.socket.close();
    bobSchoolRoom.socket.close();
  }

  section("5. 评论 / 影评：发布 + 本校筛选");
  const reviewText = `冒烟影评-${Date.now()}`;
  const reviewResponse = await fetch(`${BASE_URL}/api/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: alice.cookie },
    body: JSON.stringify({
      subjectId: SEED_SUBJECT_ID,
      kind: 1,
      title: "冒烟影评标题",
      content: reviewText,
      rating: 9,
    }),
  });
  check("发布影评成功（201）", reviewResponse.status === 201, reviewResponse.status);
  await reviewResponse.body?.cancel();

  const longWithoutTitle = await fetch(`${BASE_URL}/api/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: alice.cookie },
    body: JSON.stringify({ subjectId: SEED_SUBJECT_ID, kind: 1, content: "没有标题的长评" }),
  });
  check("长评缺标题被拒绝（400）", longWithoutTitle.status === 400, longWithoutTitle.status);
  await longWithoutTitle.body?.cancel();

  const reviewsAll = await fetch(
    `${BASE_URL}/api/reviews?subjectId=${SEED_SUBJECT_ID}`,
    { cache: "no-store" },
  );
  const reviewsAllBody = (await reviewsAll.json()) as {
    data?: { content: string; schoolId: string }[];
    total?: number;
    schoolTotal?: number;
  };
  check(
    "全体评论包含刚发布的影评",
    (reviewsAllBody.data ?? []).some((r) => r.content === reviewText),
  );

  const reviewsSchool = await fetch(
    `${BASE_URL}/api/reviews?subjectId=${SEED_SUBJECT_ID}&schoolOnly=true`,
    { headers: { Cookie: alice.cookie }, cache: "no-store" },
  );
  const reviewsSchoolBody = (await reviewsSchool.json()) as {
    data?: { content: string; schoolId: string }[];
    schoolTotal?: number;
  };
  check(
    "本校评论筛选只返回 hit 学校",
    (reviewsSchoolBody.data ?? []).length > 0 &&
      (reviewsSchoolBody.data ?? []).every((r) => r.schoolId === "hit"),
    reviewsSchoolBody.data?.map((r) => r.schoolId),
  );
  check(
    "本校评论数 < 全体评论数（外校评论被排除）",
    (reviewsSchoolBody.schoolTotal ?? 0) < (reviewsAllBody.total ?? 0),
    { school: reviewsSchoolBody.schoolTotal, all: reviewsAllBody.total },
  );

  section("6. 单集进度：读写 + 鉴权");
  //
  // ⚠️ 本节一律使用 `unbound`（刚注册、确定未绑定 BGM）而非 alice。
  // `PUT /api/progress` 在 bgmBound 时会把进度镜像到真实 BGM 账号，
  // 用已绑定的种子账号跑回归等于每次都改写开发者的真实观看进度。
  const progressBefore = await fetch(
    `${BASE_URL}/api/progress?subjectId=${SEED_SUBJECT_ID}`,
    { headers: { Cookie: unbound.cookie }, cache: "no-store" },
  );
  check("未标记时进度为空对象", (await progressBefore.json() as { entries: object }).entries !== undefined);

  const markDone = await fetch(`${BASE_URL}/api/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: unbound.cookie },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, type: 2 }),
  });
  const markDoneBody = (await markDone.json()) as {
    progress?: { episodeId: number; type: number };
    bgmBound?: boolean;
    bgmSynced?: boolean | null;
    bgmError?: string | null;
  };
  check("标记「看过」成功", markDone.status === 200, markDoneBody);
  check(
    "返回该集的目标状态",
    markDoneBody.progress?.episodeId === SEED_EPISODE_ID && markDoneBody.progress?.type === 2,
    markDoneBody.progress,
  );
  check("未绑定账号明确报告未同步（null，而非 false）", markDoneBody.bgmSynced === null, {
    bgmBound: markDoneBody.bgmBound,
    bgmSynced: markDoneBody.bgmSynced,
  });
  // 安全断言：若这里失败，说明有人把绑定账号传进了本节 ——
  // 那意味着每次回归都会往真实 BGM 写入进度。
  check(
    "本节未触碰真实上游（账号未绑定）",
    markDoneBody.bgmBound === false,
    { bgmBound: markDoneBody.bgmBound },
  );

  const progressAfter = await fetch(
    `${BASE_URL}/api/progress?subjectId=${SEED_SUBJECT_ID}`,
    { headers: { Cookie: unbound.cookie }, cache: "no-store" },
  );
  const progressAfterBody = (await progressAfter.json()) as { entries: Record<string, number> };
  check(
    "进度已持久化并可读回",
    progressAfterBody.entries?.[String(SEED_EPISODE_ID)] === 2,
    progressAfterBody.entries,
  );

  const badProgress = await fetch(`${BASE_URL}/api/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: unbound.cookie },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, type: 99 }),
  });
  check("非法进度状态被拒绝（400）", badProgress.status === 400, badProgress.status);
  await badProgress.body?.cancel();

  const anonProgress = await fetch(`${BASE_URL}/api/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ episodeId: SEED_EPISODE_ID, type: 2 }),
  });
  check("未登录标记进度被拒绝（401）", anonProgress.status === 401, anonProgress.status);
  await anonProgress.body?.cancel();

  section("7. 权限与内容治理");

  // 抓取源是全站共享配置，普通用户不应能读写
  const sourcesAsNonAdmin = await fetch(`${BASE_URL}/api/media/sources`, {
    headers: { Cookie: bob.cookie },
    cache: "no-store",
  });
  check(
    "非管理员访问抓取源被拒（403）",
    sourcesAsNonAdmin.status === 403,
    sourcesAsNonAdmin.status,
  );
  await sourcesAsNonAdmin.body?.cancel();

  const sourcesAnon = await fetch(`${BASE_URL}/api/media/sources`, { cache: "no-store" });
  check("未登录访问抓取源被拒（401）", sourcesAnon.status === 401, sourcesAnon.status);
  await sourcesAnon.body?.cancel();

  // 弹幕屏蔽词：由 DANMAKU_BLOCKED_WORDS 配置，未配置时不应误伤
  const blockedText = process.env.SMOKE_BLOCKED_WORD ?? "";
  if (blockedText) {
    const blocked = await postDanmaku(alice, `测试含${blockedText}的内容`, 15_000);
    check(`含屏蔽词「${blockedText}」的弹幕被拒绝（400）`, blocked.status === 400, blocked.body);
  } else {
    // 未配置词表时验证「不误伤」——正常弹幕必须能发出去
    const normal = await postDanmaku(alice, `屏蔽词未配置时的正常弹幕 ${Date.now()}`, 15_000);
    check("未配置屏蔽词时不误伤正常弹幕", normal.status === 201, normal.body);
  }

  // 举报
  const ownDanmaku = await postDanmaku(alice, `举报测试用 ${Date.now()}`, 16_000);
  const ownId = (ownDanmaku.body as { data?: { id: string } }).data?.id;

  if (ownId) {
    const reportOwn = await fetch(`${BASE_URL}/api/danmaku/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: alice.cookie },
      body: JSON.stringify({ danmakuId: ownId, reason: "测试" }),
    });
    check("不能举报自己的弹幕（400）", reportOwn.status === 400, reportOwn.status);
    await reportOwn.body?.cancel();

    const reportByOther = await fetch(`${BASE_URL}/api/danmaku/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: bob.cookie },
      body: JSON.stringify({ danmakuId: ownId, reason: "测试举报" }),
    });
    check("他人可举报（201）", reportByOther.status === 201, reportByOther.status);
    await reportByOther.body?.cancel();

    const reportAgain = await fetch(`${BASE_URL}/api/danmaku/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: bob.cookie },
      body: JSON.stringify({ danmakuId: ownId, reason: "重复举报" }),
    });
    check("重复举报被拒（409）", reportAgain.status === 409, reportAgain.status);
    await reportAgain.body?.cancel();
  }

  const reportAnon = await fetch(`${BASE_URL}/api/danmaku/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ danmakuId: "nonexistent", reason: "x" }),
  });
  check("未登录举报被拒（401）", reportAnon.status === 401, reportAnon.status);
  await reportAnon.body?.cancel();

  section("8. 新番时间表（由 air_date 检索聚合）");
  const schedule = await fetchWithUpstreamRetry(`${BASE_URL}/api/schedule`);
  const scheduleBody = JSON.parse(schedule.text) as {
    weekStart?: string;
    weekEnd?: string;
    days?: { date: string; items: { id: number }[] }[];
    error?: string;
    detail?: string;
  };
  check(
    "时间表返回 200",
    schedule.response.ok,
    `${scheduleBody.error ?? ""} ${scheduleBody.detail ?? ""}`.trim(),
  );
  check(
    "周区间跨度 7 天",
    scheduleBody.days !== undefined &&
      daysBetween(scheduleBody.weekStart!, scheduleBody.weekEnd!) === 6,
    { start: scheduleBody.weekStart, end: scheduleBody.weekEnd },
  );
  check(
    "所有条目日期都落在本周区间内",
    (scheduleBody.days ?? []).every(
      (day) => day.date >= scheduleBody.weekStart! && day.date <= scheduleBody.weekEnd!,
    ),
    (scheduleBody.days ?? []).map((day) => day.date),
  );
  check(
    "返回的每日分组只含当周（不可能跨周泄漏）",
    new Set((scheduleBody.days ?? []).map((day) => day.date)).size ===
      (scheduleBody.days ?? []).length,
  );

  const schedulePage = await fetch(`${BASE_URL}/schedule`, { cache: "no-store" });
  const scheduleHtml = await schedulePage.text();
  check("时间表页面可渲染", schedulePage.ok && scheduleHtml.includes("新番时间表"));

  function daysBetween(from: string, to: string): number {
    return Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000),
    );
  }

  section("结果");
  console.log(`  通过 ${checks - failures} / ${checks}`);
  if (failures > 0) {
    console.error(`  ✘ ${failures} 项失败`);
    process.exitCode = 1;
  } else {
    console.log("  ✔ 全部通过");
  }
}

main()
  .catch((error) => {
    console.error("\n冒烟测试异常终止：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
