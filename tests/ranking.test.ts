/**
 * 排行榜取数测试。
 *
 * ## 防的是什么
 *
 * 这段 where 里两条过滤都对应**真实的线上事故**，而它们写在页面组件里
 * 就只能靠肉眼保证 —— 没有断言会失败，所以坏了也没人知道：
 *
 * 1. **测试桩霸榜** —— 早期用 `900000` 基址写的桩条目 `rank` 全是造的 1，
 *    基址改成 `800000` 后没人清理，榜首长期是「桩条目 900010」。
 * 2. **`rank = 0` 的条目排在最前** —— BGM 对「暂无排名」给 `0` 而非省略字段，
 *    只判断 `rank != null` 会让 0 排在所有真实名次之前。
 *
 * 因此这里**往真实库里写合成行**再查 —— 纯函数断言证明不了 where 真的被用上。
 * 用 `STUB_SUBJECT_ID_MIN` 段位建行，测完即删。
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { SubjectType } from "@/lib/bgm/client";
import { STUB_SUBJECT_ID_MIN } from "@/lib/subject-ids";
import { RANKING_PAGE_SIZE, listRanking, rankingWhere } from "@/lib/subject/ranking";

/*
 * 行 ID 用 `STUB_SUBJECT_ID_MIN + 900` 起 —— 落在桩段内，因此
 * `rankingWhere` 本来就会把它们排除。为了测「排除」这件事，我们需要
 * 真实段位（< STUB_SUBJECT_ID_MIN）的行来做对照。
 *
 * 真实段位取一个远离线上数据的号段：`990_000` 不行（在桩段内），
 * 用 `799_000` 起（紧贴桩段下沿、且 BGM 真实 ID 远小于它）。
 */
const REAL_ID_BASE = 799_000;
const STUB_ID_BASE = STUB_SUBJECT_ID_MIN + 900;
/** 一条非动画条目 —— 库里**只有动画**，所以类型筛选必须自带对照行才能测。 */
const BOOK_ID = REAL_ID_BASE + 4;

async function cleanup(): Promise<void> {
  await prisma.subject.deleteMany({
    where: {
      id: { in: [REAL_ID_BASE + 1, REAL_ID_BASE + 2, REAL_ID_BASE + 3, REAL_ID_BASE + 4, STUB_ID_BASE] },
    },
  });
}

after(cleanup);

test("排行榜排除测试桩与 rank=0（两者都曾实际排到最前）", async () => {
  await cleanup();
  await prisma.subject.createMany({
    data: [
      // 正常在榜
      { id: REAL_ID_BASE + 1, name: "测试-正常", nameCn: "测试-正常", type: SubjectType.Anime, rank: 7, score: 9.0 },
      // 造假的桩：rank 极小，若不排除会霸占榜首
      { id: STUB_ID_BASE, name: "测试-桩", nameCn: "桩条目", type: SubjectType.Anime, rank: 1, score: 7 },
      // 暂无排名（BGM 给 0）
      { id: REAL_ID_BASE + 2, name: "测试-零名次", nameCn: "测试-零名次", type: SubjectType.Anime, rank: 0, score: 5 },
      // rank 为 null
      { id: REAL_ID_BASE + 3, name: "测试-无名次", nameCn: "测试-无名次", type: SubjectType.Anime, rank: null, score: 5 },
    ],
  });

  const { subjects } = await listRanking({ type: String(SubjectType.Anime), page: 1 });
  const ids = subjects.map((s) => s.id);

  assert.ok(ids.includes(REAL_ID_BASE + 1), "正常在榜的条目必须出现");
  assert.ok(!ids.includes(STUB_ID_BASE), "桩条目必须被排除（曾霸占榜首）");
  assert.ok(!ids.includes(REAL_ID_BASE + 2), "rank=0 的条目必须被排除（0 会排到最前）");
  assert.ok(!ids.includes(REAL_ID_BASE + 3), "rank=null 的条目必须被排除");
});

test("排序按 rank 升序，且总数与列表页一致（分页不漏不重）", async () => {
  await cleanup();
  await prisma.subject.createMany({
    data: [
      { id: REAL_ID_BASE + 1, name: "测试-甲", nameCn: "测试-甲", type: SubjectType.Anime, rank: 2, score: 9.5 },
      { id: REAL_ID_BASE + 2, name: "测试-乙", nameCn: "测试-乙", type: SubjectType.Anime, rank: 5, score: 9.2 },
    ],
  });

  const page1 = await listRanking({ type: String(SubjectType.Anime), page: 1 });
  assert.ok(page1.total >= 2, `总数应至少包含这两条，实际 ${page1.total}`);

  const ranks = page1.subjects.map((s) => s.rank ?? 0);
  const sorted = [...ranks].sort((a, b) => a - b);
  assert.deepEqual(ranks, sorted, "必须按 rank 升序");

  // 翻页不重不漏：第 2 页与第 1 页无交集
  const page2 = await listRanking({ type: String(SubjectType.Anime), page: 2 });
  const overlap = page2.subjects.filter((s) => page1.subjects.some((p) => p.id === s.id));
  assert.equal(overlap.length, 0, "相邻页不得出现同一条目");
});

test("类型筛选真的生效：书籍条目只出现在「全部」里", async () => {
  await cleanup();
  /*
   * **必须自带对照行**：库里 393 条全是动画（`type=2`），
   * 所以「全部 = 动画」在这台库上无法区分「筛选生效」与「筛选被忽略」。
   * 第一版就是靠库里没有其它类型才「通过」的 —— 那种断言没有价值。
   */
  await prisma.subject.createMany({
    data: [
      { id: REAL_ID_BASE + 1, name: "测试-动画", nameCn: "测试-动画", type: SubjectType.Anime, rank: 11 },
      { id: BOOK_ID, name: "测试-书籍", nameCn: "测试-书籍", type: SubjectType.Book, rank: 12 },
    ],
  });

  const anime = await listRanking({ type: String(SubjectType.Anime), page: 1 });
  const all = await listRanking({ type: "all", page: 1 });

  assert.ok(
    anime.subjects.some((s) => s.id === REAL_ID_BASE + 1),
    "动画条目应出现在动画筛选里",
  );
  assert.ok(
    !anime.subjects.some((s) => s.id === BOOK_ID),
    "书籍条目不得出现在动画筛选里 —— 出现说明 type 条件没生效",
  );
  assert.ok(
    all.subjects.some((s) => s.id === BOOK_ID),
    "书籍条目应出现在「全部」里 —— 不出现说明 all 分支误加了类型条件",
  );
  assert.ok(all.total > anime.total, "「全部」的总数必须大于只筛动画");
});

test("每页条数不超过 PAGE_SIZE（长列表必须分页）", async () => {
  const { subjects } = await listRanking({ type: "all", page: 1 });
  assert.ok(subjects.length <= RANKING_PAGE_SIZE, `实际 ${subjects.length} 条`);
});

test("where 条件本身：桩段与 rank<=0 都被排除", () => {
  // 这条断言锚在**字面量语义**上，避免将来有人把 `lt` 写成 `lte`
  // （那样基址本身会被当成真实条目）。
  const where = rankingWhere("all") as { rank: { gt: number }; id: { lt: number } };
  assert.equal(where.rank.gt, 0, "必须用 gt（rank=0 表示暂无排名）");
  assert.equal(where.id.lt, STUB_SUBJECT_ID_MIN, "必须用 lt（基址本身是桩）");
});
