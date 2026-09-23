/**
 * 开发种子数据：一所学校 + 两名不同学校的用户。
 *
 * 造两个不同学校是为了验证「只看本校」这条核心链路 —— 单校数据无法证明隔离生效。
 *
 * 运行：`npm run db:seed`
 */

import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/prisma";

const SEED_PASSWORD = "hitani-dev-2026";

async function main() {
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
