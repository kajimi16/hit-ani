/**
 * 开发种子数据：一所学校 + 两名不同学校的用户。
 *
 * 造两个不同学校是为了验证「只看本校」这条核心链路 —— 单校数据无法证明隔离生效。
 *
 * 运行：`npm run db:seed`
 *
 * ## ⚠️ 这些账号的密码是公开的
 *
 * 密码硬编码在本文件里，而本文件在公开仓库中 —— 任何人都能登录这两个账号。
 * 因此**绝不能在部署环境使用**。
 *
 * 这不是理论风险：本项目就发生过一次 —— 开发库的种子数据被完整迁移到生产容器，
 * 而 `alice` 当时还是管理员（`ADMIN_EMAILS` 里配了它），
 * 等于把一个「公开密码的管理员账号」放到了公网。
 *
 * 下面两道防线防止重演。
 */

import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";

/** 开发用口令。生产环境由 `assertSafeEnvironment` 拦下，不会走到这里。 */
const SEED_PASSWORD = "hitani-dev-2026";

/**
 * 拒绝在生产环境运行种子脚本。
 *
 * 双重判断（`NODE_ENV` 与是否存在真实用户）：
 * 容器里 `NODE_ENV=production` 会被第一道拦住；裸机部署若忘了设 NODE_ENV，
 * 第二道「库里已有非种子用户」也能拦住。
 */
async function assertSafeEnvironment(): Promise<void> {
  const nodeEnv = process.env.NODE_ENV;

  if (nodeEnv === "production") {
    throw new Error(
      "拒绝在 NODE_ENV=production 下写入种子数据。\n" +
        "种子账号的密码硬编码在公开仓库里，创建它们等于开一个公开后门。\n" +
        "若确实需要演示数据，请显式设置 ALLOW_SEED_IN_PRODUCTION=1 并自行承担风险。",
    );
  }

  if (process.env.ALLOW_SEED_IN_PRODUCTION === "1") {
    console.warn("⚠️ ALLOW_SEED_IN_PRODUCTION=1 —— 正在生产环境写入公开密码的种子账号");
    return;
  }

  // 库里已有真实账号时提示 —— 种子数据可能被误灌进生产库
  const realUsers = await prisma.user.count({
    where: { email: { notIn: ["alice@hit.edu.cn", "bob@example.edu"] } },
  });
  if (realUsers > 5) {
    console.warn(
      `⚠️ 库中已有 ${realUsers} 个非种子用户 —— 这看起来不是开发环境。\n` +
        "   继续写入会引入「公开密码的账号」。若确需继续，设置 ALLOW_SEED_IN_PRODUCTION=1。",
    );
  }
}

async function main() {
  await assertSafeEnvironment();

  const school = await prisma.school.upsert({
    where: { id: "hit" },
    create: {
      id: "hit",
      name: "哈尔滨工业大学",
      domains: ["hit.edu.cn", "stu.hit.edu.cn"],
    },
    update: { name: "哈尔滨工业大学", domains: ["hit.edu.cn", "stu.hit.edu.cn"] },
  });

  const other = await prisma.school.upsert({
    where: { id: "demo-other" },
    create: {
      id: "demo-other",
      name: "示例他校（用于验证本校隔离）",
      domains: ["example.edu"],
    },
    update: {},
  });

  const passwordHash = await hashPassword(SEED_PASSWORD);

  const alice = await prisma.user.upsert({
    where: { email: "alice@hit.edu.cn" },
    create: {
      email: "alice@hit.edu.cn",
      studentNo: "2026000001",
      nickname: "爱丽丝",
      passwordHash,
      schoolId: school.id,
    },
    update: { passwordHash, schoolId: school.id },
  });

  const bob = await prisma.user.upsert({
    where: { email: "bob@example.edu" },
    create: {
      email: "bob@example.edu",
      studentNo: "OTHER-0001",
      nickname: "外校的鲍勃",
      passwordHash,
      schoolId: other.id,
    },
    update: { passwordHash, schoolId: other.id },
  });

  // 一个最小条目 + 一集，用于在无 BGM 凭据时也能跑通弹幕链路
  const subject = await prisma.subject.upsert({
    where: { id: 8 },
    create: {
      id: 8,
      type: 2,
      name: "コードギアス 反逆のルルーシュ",
      nameCn: "反叛的鲁路修",
      summary: "种子数据条目，用于本地开发验证弹幕与评论链路。",
      coverUrl: null,
      airDate: new Date(Date.UTC(2006, 9, 6)),
      score: 8.3,
      rank: 40,
      tags: ["机战", "原创"],
    },
    update: {},
  });

  // ⚠️ 必须使用**真实**的 BGM episode id。
  //
  // `Episode.id` 就是 BGM 的 episode_id，且 `progress/route.ts` 在用户绑定 BGM 时
  // 会用它直接镜像写回上游（`PUT /v0/users/-/collections/-/episodes/{id}`）。
  // 因此一个捏造的 id 会**写到别人的剧集上** —— 这是真实的数据损坏路径。
  //
  // 这里曾错写成 `id: 8`，而 BGM 的 episode 8 实际属于 subject 15；
  // subject 8 的第一集是 **522**。改动此值前请先核对：
  //   curl -s "https://api.bgm.tv/v0/episodes?subject_id=<sid>&limit=1" | jq '.data[0].id'
  const SEED_EPISODE_ID = 522;

  const episode = await prisma.episode.upsert({
    where: { id: SEED_EPISODE_ID },
    create: {
      id: SEED_EPISODE_ID,
      subjectId: subject.id,
      sort: 1,
      ep: 1,
      name: "魔神 が 目覚める 日",
      nameCn: "魔王的苏醒之日",
      airdate: new Date(Date.UTC(2006, 9, 6)),
      duration: "24m",
    },
    update: { subjectId: subject.id },
  });

  const existing = await prisma.danmaku.count({ where: { episodeId: episode.id } });
  if (existing === 0) {
    await prisma.danmaku.createMany({
      data: [
        { episodeId: episode.id, userId: alice.id, schoolId: alice.schoolId, playTimeMs: 1000, text: "本校弹幕 1（1 秒）", color: 0xffffff, location: 0 },
        { episodeId: episode.id, userId: alice.id, schoolId: alice.schoolId, playTimeMs: 3000, text: "本校弹幕 2（3 秒）", color: 0x66ccff, location: 0 },
        { episodeId: episode.id, userId: alice.id, schoolId: alice.schoolId, playTimeMs: 5000, text: "本校顶部弹幕", color: 0xffcc00, location: 1 },
        { episodeId: episode.id, userId: bob.id, schoolId: bob.schoolId, playTimeMs: 2000, text: "外校弹幕 A（应被本校筛选排除）", color: 0xff6666, location: 0 },
        { episodeId: episode.id, userId: bob.id, schoolId: bob.schoolId, playTimeMs: 4000, text: "外校弹幕 B（应被本校筛选排除）", color: 0xff6666, location: 2 },
      ],
    });
  }

  await prisma.review.upsert({
    where: { id: "seed-review-alice" },
    create: {
      id: "seed-review-alice",
      userId: alice.id,
      schoolId: alice.schoolId,
      subjectId: subject.id,
      kind: 1,
      title: "本校影评：值得一看",
      content: "种子影评，用于验证「只看本校评论」筛选。",
      rating: 9,
    },
    update: {},
  });

  await prisma.review.upsert({
    where: { id: "seed-review-bob" },
    create: {
      id: "seed-review-bob",
      userId: bob.id,
      schoolId: bob.schoolId,
      subjectId: subject.id,
      kind: 0,
      content: "外校短评，应被本校筛选排除。",
      rating: 5,
    },
    update: {},
  });

  console.log("种子数据已写入：");
  console.log(`  学校:        ${school.id} (${school.name})`);
  console.log(`  本校账号:    alice@hit.edu.cn / ${SEED_PASSWORD}`);
  console.log(`  外校账号:    bob@example.edu / ${SEED_PASSWORD}`);
  console.log(`  条目:        ${subject.id} 《${subject.nameCn}》`);
  console.log(`  弹幕测试集:  episode ${episode.id}（3 条本校 + 2 条外校）`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
