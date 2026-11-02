/**
 * 用站级 Bangumi 令牌补全 `Subject.nsfw`。
 *
 * ## 为什么需要一次性回填
 *
 * `nsfw` 标记只在「详情接口 + 有权限的令牌」这条路上才拿得到，而历史条目
 * 大多是通过导入（`SlimSubject`，**没有该字段**）或匿名详情（NSFW 条目会
 * 直接 404）进来的 —— 它们的 `nsfw` 全是默认的 `false`。
 *
 * ## 幂等
 *
 * 每次运行都重新拉一遍并覆盖。条目是少数（几百条），而「已经是对的」与
 * 「其实还没确认过」在库里无法区分，所以不做增量判断。
 *
 * ## 用法
 *
 *   npm run nsfw:backfill            # 全部
 *   npm run nsfw:backfill -- 20      # 只处理前 20 条（试跑）
 *
 * 生产环境运行时注意 `DATABASE_URL` 指向容器库（见 `admin-grant.ts` 的说明）。
 */

import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "@/lib/prisma";
import { getSubject } from "@/lib/bgm/client";
import { getSiteBgmToken } from "@/lib/bgm/site-token";

/** 相邻两条之间停多久。上游没有公开配额，取一个保守值。 */
const DELAY_MS = 300;

async function main() {
  const limitArg = process.argv[2];
  let limit: number | undefined;
  if (limitArg !== undefined) {
    const parsed = Number(limitArg);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error("参数必须是正整数（或省略）");
      process.exit(1);
    }
    limit = parsed;
  }

  const token = await getSiteBgmToken();
  if (!token) {
    console.error(
      "拿不到站级令牌：需要一个**管理员**账号绑定 Bangumi（且令牌未过期）。\n" +
        "没有它时所有 NSFW 条目都会 404，回填没有意义 —— 直接退出。",
    );
    process.exit(1);
  }

  const subjects = await prisma.subject.findMany({
    select: { id: true, name: true, nsfw: true },
    orderBy: { id: "asc" },
    ...(limit ? { take: limit } : {}),
  });

  console.log(`待检查 ${subjects.length} 条\n`);

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const [index, subject] of subjects.entries()) {
    const prefix = `  [${index + 1}/${subjects.length}] ${subject.id}`;
    try {
      const detail = await getSubject(subject.id, { accessToken: token });
      const next = detail.nsfw === true;
      if (next !== subject.nsfw) {
        await prisma.subject.update({ where: { id: subject.id }, data: { nsfw: next } });
        updated += 1;
        console.log(`${prefix} ${subject.nsfw} → ${next}  ${subject.name.slice(0, 24)}`);
      } else {
        skipped += 1;
      }
    } catch (error) {
      /*
       * 404 是**预期内**的：即使有令牌，已被删除的条目也会 404。
       * 记下来但不中断 —— 一条失败不该让整轮回填停住。
       */
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${prefix} 跳过（${message.slice(0, 60)}）`);
    }
    await delay(DELAY_MS);
  }

  const nsfwCount = await prisma.subject.count({ where: { nsfw: true } });
  console.log(
    `\n完成：更新 ${updated}，无需改动 ${skipped}，失败/跳过 ${failed}。` +
      `\n库中标记为 NSFW 的条目：${nsfwCount}`,
  );
}

main()
  .catch((error) => {
    console.error("回填失败：", error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
