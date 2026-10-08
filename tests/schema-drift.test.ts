/**
 * schema 漂移检查测试。
 *
 * ## 防的是什么
 *
 * 真实事故：`migrate` 与 `web` 是**两个镜像**，只重建 web 时 `migrate`
 * 仍跑旧 schema，`prisma db push` 于是打印误导性的
 * 「The database is already in sync with the Prisma schema.」——
 * 说的是「库与 migrate 镜像一致」，而 web 是新代码。结果新代码查一个不存在的
 * 列，**所有登录用户的条目页 500**。
 *
 * 因此这个检查必须真的能检测出来。**「永远不会报漂移」这种坏法必须有断言
 * 能抓住** —— 所以下面的测试在一个事务里临时删列，再用**同一个事务的客户端**
 * 调用被测函数（用另一条连接会看不到未提交的 DDL，测试就会假通过）。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { findSchemaDrift } from "@/lib/db/schema-drift";

/** 在事务里删掉一列，跑检查，然后回滚（DDL 在 Postgres 里可回滚）。 */
async function driftWith(column: string): Promise<Awaited<ReturnType<typeof findSchemaDrift>>> {
  const rollback = new Error("rollback");
  let result: Awaited<ReturnType<typeof findSchemaDrift>> = [];
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "Collection" DROP COLUMN "${column}"`);
      result = await findSchemaDrift(tx);
      throw rollback;
    });
  } catch (error) {
    // 事务是被我们主动回滚的 —— 其他异常要暴露出来，否则会掩盖真问题
    if (error !== rollback) throw error;
  }
  return result;
}

test("★ 列缺失时必须报出漂移（否则这条检查等于没有）", async () => {
  const drift = await driftWith("playbackPositionMs");
  assert.ok(
    drift.some((d) => d.model === "collection"),
    `删掉 Collection.playbackPositionMs 后必须报出漂移，实际: ${JSON.stringify(drift)}`,
  );
});

test("★ 报出的实体里带列名 —— 只说「collection 漂移」没法定位", async () => {
  const drift = await driftWith("playbackPositionMs");
  const item = drift.find((d) => d.model === "collection");
  assert.ok(item, "未报出 collection 漂移");
  // Prisma 在 meta.column 里给出的可能是 `Collection.playbackPositionMs`，
  // 要求它**包含**列名即可（不同版本的格式不一样，钉死会变成脆测试）
  assert.ok(
    item.column.includes("playbackPositionMs"),
    `报出的列名应含 playbackPositionMs，实际: ${item.column}`,
  );
});

test("schema 完好时不报任何漂移（否则这条警告会被忽略）", async () => {
  const drift = await findSchemaDrift(prisma);
  assert.deepEqual(drift, [], `schema 应当无漂移，实际: ${JSON.stringify(drift)}`);
});

test("非 P2022 错误被静默跳过 —— 检测器的职责是漂移，不是联通性", async () => {
  // 一个所有查询都抛连接错误的假客户端
  const broken = {
    user: {
      findFirst: () => {
        throw new Prisma.PrismaClientKnownRequestError("boom", {
          code: "P1001",
          clientVersion: "test",
        });
      },
    },
  };
  const drift = await findSchemaDrift(broken);
  assert.deepEqual(drift, [], "连接错误不该被报成 schema 漂移");
});

test("客户端不认识该模型时跳过，不抛异常", async () => {
  const drift = await findSchemaDrift({});
  assert.deepEqual(drift, []);
});
