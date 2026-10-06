/**
 * 导入路径的**写入侧**测试 —— 隐私不变量在这一侧。
 *
 * ## 为什么这个文件重要
 *
 * 隐私的**读取**侧有测试（`isCommentVisible`、时光机过滤、`shouldHidePrivate`），
 * 而**写入**侧此前是 **0 处引用**。这种不对称很危险：
 *
 * - 读取侧那些测试靠**合成的** `isPrivate: true` 通过；
 * - 没有任何测试验证**导入真的会产生 `true`**。
 *
 * 也就是说：`upsertCollection` 里那行 `isPrivate: item.private === true`
 * 若被写成 `false`、或整个键被漏掉，所有读取侧的测试**照样全绿**，
 * 而实际后果是 —— 按 `import.ts` 自己的注释 ——
 * 「等于替用户公开了他特意设为私密的内容」。
 *
 * 同一路径上还有一处**本会话被误删过**的 `deleteMany`（制作人员幽灵职位），
 * 也是靠这里守着。
 *
 * ## 怎么测
 *
 * `importUserLibrary` / `enrichSubject` 都经过 `fetch`，因此用桩返回上游
 * 响应，让它走**真实的数据库写入**（不是模拟）—— 断言落库后的行。
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { enrichSubject, importUserLibrary } from "@/lib/bgm/import";
import { prisma } from "@/lib/prisma";

const REAL_FETCH = globalThis.fetch;
const EMAIL_PREFIX = "import-test-";

/** BGM 每页固定 20 条（实测），因此 `fetchAllCollections` 会翻多页。 */
const PAGE_SIZE = 20;

/**
 * 构造一条收藏项。字段形状取自 `UserSubjectCollection`。
 *
 * `private` 刻意做成可选 —— 上游**可能不给这个字段**，那时应当当公开处理
 * （而不是崩掉或当私密）。
 */
function collection(subjectId: number, over: Record<string, unknown> = {}) {
  return {
    subject_id: subjectId,
    subject_type: 2,
    rate: 0,
    type: 3,
    comment: null,
    tags: [],
    ep_status: 0,
    vol_status: 0,
    updated_at: "2026-03-01T10:00:00.000Z",
    subject: {
      id: subjectId,
      type: 2,
      name: `上游条目 ${subjectId}`,
      name_cn: `条目 ${subjectId}`,
      short_summary: "截短简介",
      date: "2026-01-04",
      images: { large: "https://lain.bgm.tv/l.jpg", common: "https://lain.bgm.tv/c.jpg" },
      score: 8.4,
      rank: 66,
      tags: [{ name: "治愈", count: 100 }],
    },
    ...over,
  };
}

/** 桩：`/v0/users/<u>/collections` 按 offset 分页返回。 */
function stubCollections(items: unknown[]): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith("/collections")) {
      state.calls += 1;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total: items.length,
            limit: PAGE_SIZE,
            offset,
            data: items.slice(offset, offset + PAGE_SIZE),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;
  return state;
}

async function makeUser(suffix: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${EMAIL_PREFIX}${suffix}@stu.hit.edu.cn`,
      nickname: `导入测试${suffix}`,
      schoolId: "hit",
      passwordHash: "x",
    },
    select: { id: true },
  });
  return user.id;
}

/** 清理：只动本文件造的数据，且用不可能的 id 段避免撞真实条目。 */
const TEST_SUBJECT_BASE = 990000;

before(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.subject.deleteMany({ where: { id: { gte: TEST_SUBJECT_BASE, lt: TEST_SUBJECT_BASE + 100 } } });
});

after(async () => {
  globalThis.fetch = REAL_FETCH;
  await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
  await prisma.subject.deleteMany({ where: { id: { gte: TEST_SUBJECT_BASE, lt: TEST_SUBJECT_BASE + 100 } } });
});

/* ================================================================== *
 * 隐私不变量：写入侧
 * ================================================================== */

test("上游标为私密的收藏，导入后 `isPrivate` 必须是 true", async () => {
  // 这是本文件存在的主要理由。读取侧的测试都靠合成数据，只有这里验证
  // 「导入真的会产生 true」。
  stubCollections([collection(TEST_SUBJECT_BASE + 1, { private: true })]);
  const userId = await makeUser("private");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  const row = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId: TEST_SUBJECT_BASE + 1 } },
  });
  assert.equal(row?.isPrivate, true, "私密收藏被写成了公开 —— 等于替用户公开他的私密内容");
});

test("上游未标私密的收藏，导入后 `isPrivate` 是 false", async () => {
  stubCollections([collection(TEST_SUBJECT_BASE + 2, { private: false })]);
  const userId = await makeUser("public");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  const row = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId: TEST_SUBJECT_BASE + 2 } },
  });
  assert.equal(row?.isPrivate, false);
});

test("上游**不给** `private` 字段时当公开（而不是崩溃或当私密）", async () => {
  // 上游可能省略该字段。当私密会隐藏用户本可公开的内容，
  // 崩溃则整批导入失败 —— 两者都不对，默认公开才是。
  stubCollections([collection(TEST_SUBJECT_BASE + 3)]);
  const userId = await makeUser("missing");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  const row = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId: TEST_SUBJECT_BASE + 3 } },
  });
  assert.equal(row?.isPrivate, false);
});

test("`private: 0` / 空值等非 true 值都当公开", async () => {
  // `item.private === true` 是严格比较 —— 上游给 0 或 "" 时不能当成私密。
  const ids = [4, 5, 6].map((n) => TEST_SUBJECT_BASE + n);
  stubCollections([
    collection(ids[0]!, { private: 0 }),
    collection(ids[1]!, { private: "" }),
    collection(ids[2]!, { private: null }),
  ]);
  const userId = await makeUser("falsy");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  for (const id of ids) {
    const row = await prisma.collection.findUnique({
      where: { userId_subjectId: { userId, subjectId: id } },
    });
    assert.equal(row?.isPrivate, false, `条目 ${id} 的 private 不是 true，应写 false`);
  }
});

test("重新导入时私密标记会被更新（不会因已存在而保留旧值）", async () => {
  // 用户在 BGM 上把某条改成私密后重新导入 —— 若 update 分支漏了 isPrivate，
  // 本地会一直保持公开。这是「漏键」的另一种表现形式。
  const id = TEST_SUBJECT_BASE + 7;
  stubCollections([collection(id, { private: false })]);
  const userId = await makeUser("reimport");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });
  assert.equal(
    (await prisma.collection.findUnique({ where: { userId_subjectId: { userId, subjectId: id } } }))?.isPrivate,
    false,
  );

  stubCollections([collection(id, { private: true })]);
  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  assert.equal(
    (await prisma.collection.findUnique({ where: { userId_subjectId: { userId, subjectId: id } } }))?.isPrivate,
    true,
    "重新导入未同步私密标记的变更",
  );
});

/* ================================================================== *
 * 导入的其它写入行为
 * ================================================================== */

test("导入会分页取完（不是只取第一页）", async () => {
  // 早先的回填脚本就踩过「扫描数够了就早退」，只处理了第一页。
  const items = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => collection(TEST_SUBJECT_BASE + 10 + i));
  const stub = stubCollections(items);
  const userId = await makeUser("paging");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  const count = await prisma.collection.count({ where: { userId } });
  assert.equal(count, items.length, `只导入了 ${count} 条，应为 ${items.length}`);
  assert.ok(stub.calls >= 2, `只请求了 ${stub.calls} 次，分页未生效`);
});

test("`collectedAt` 从上游 `updated_at` 写入", async () => {
  const id = TEST_SUBJECT_BASE + 30;
  stubCollections([collection(id, { updated_at: "2026-03-01T10:00:00.000Z" })]);
  const userId = await makeUser("collected");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  const row = await prisma.collection.findUnique({
    where: { userId_subjectId: { userId, subjectId: id } },
  });
  assert.equal(row?.collectedAt?.toISOString(), "2026-03-01T10:00:00.000Z");
});

test("导入顺序正确：Collection 有外键指向 Subject，两行都要在", async () => {
  // 顺序反了会直接外键失败（注释里写明）。这条守着那个顺序。
  const id = TEST_SUBJECT_BASE + 31;
  stubCollections([collection(id)]);
  const userId = await makeUser("order");

  await importUserLibrary(userId, { username: "u", accessToken: "t" });

  assert.ok(await prisma.subject.findUnique({ where: { id } }), "Subject 未写入");
  assert.ok(
    await prisma.collection.findUnique({ where: { userId_subjectId: { userId, subjectId: id } } }),
    "Collection 未写入",
  );
});

/* ================================================================== *
 * 制作人员：本会话被误删过 deleteMany 的地方
 * ================================================================== */

test("重新同步制作人员时**先清后写** —— 上游删掉的职位不会留成幽灵", async () => {
  // `deleteMany` 在本会话的一次无关编辑中被误删过（注释还在、调用没了）。
  // 主键是 (subjectId, personId, relation)，因此上游改职位名后旧行不会被
  // `createMany` 覆盖 —— `skipDuplicates` 只挡重复插入、不清理本地多出的行。
  const subjectId = TEST_SUBJECT_BASE + 40;

  await prisma.subject.create({
    data: {
      id: subjectId,
      type: 2,
      name: "制作人员测试",
      detailSyncedAt: new Date(),
      staffSyncedAt: new Date(),
    },
  });
  // 预置一个「上游已经删掉」的幽灵职位
  await prisma.subjectPerson.create({
    data: { subjectId, personId: 1, relation: "幽灵职位", name: "某人", career: [], sort: 0 },
  });

  // 让 enrichSubject 认为「还缺章节」，从而真的走一遍（含人员同步）
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith(`/subjects/${subjectId}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: subjectId, type: 2, name: "制作人员测试" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.pathname.endsWith("/persons")) {
      // 上游现在只给一个职位
      return Promise.resolve(
        new Response(
          JSON.stringify([{ id: 2, name: "导演", relation: "导演", career: ["producer"], images: {} }]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url.pathname.endsWith("/episodes")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;

  // 先清掉 staffSyncedAt，强制重同步
  await prisma.subject.update({ where: { id: subjectId }, data: { staffSyncedAt: null } });
  await enrichSubject(subjectId, { force: true });

  const persons = await prisma.subjectPerson.findMany({ where: { subjectId } });
  const relations = persons.map((p) => p.relation);
  assert.equal(
    relations.includes("幽灵职位"),
    false,
    "上游已删除的职位仍留在本地 —— deleteMany 没生效",
  );
  assert.ok(relations.includes("导演"), "上游当前的职位应被写入");
});

test("制作人员同步失败**不影响**条目本身的补齐", async () => {
  // 人员是附加信息，接口挂了不该让整个条目页报错。
  const subjectId = TEST_SUBJECT_BASE + 41;
  globalThis.fetch = ((rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith(`/subjects/${subjectId}`)) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: subjectId, type: 2, name: "人员接口挂了" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    if (url.pathname.endsWith("/persons")) {
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    if (url.pathname.endsWith("/episodes")) {
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return REAL_FETCH(rawUrl, init);
  }) as typeof fetch;

  const result = await enrichSubject(subjectId, { force: true });
  assert.equal(result.staff, 0, "人员接口失败时应返回 0 而不是抛错");
  const subject = await prisma.subject.findUnique({ where: { id: subjectId } });
  assert.ok(subject?.detailSyncedAt, "条目本身应被标记为已补齐");
});
