/**
 * 数据库 schema 漂移检查 —— 启动时喊出来。
 *
 * ## 为什么需要它（真实事故）
 *
 * 本项目用 `prisma db push`（没有 migration 文件），而 **`migrate` 是一个
 * 独立的镜像**。于是很容易只重建 web：
 *
 * ```bash
 * docker compose build web gateway   # ← 漏了 migrate
 * docker compose up -d
 * ```
 *
 * 此时 `migrate` 容器里跑的是**旧 schema**，`prisma db push` 会打印
 *
 *     The database is already in sync with the Prisma schema.
 *
 * —— 这句话是**误导性的**：它说的是「库与 migrate 镜像里的 schema 一致」，
 * 而 web 镜像是新代码。结果是新代码查询一个不存在的列，Prisma 抛 P2022，
 * **所有登录用户的条目页直接 500**（`collection.findUnique` 在页面主路径上）。
 *
 * 实测踩过：整站对登录用户不可用，而日志里只有一条 Prisma 错误，
 * 「already in sync」还把人往反方向带。
 *
 * ## 为什么是「无参数的 findFirst」
 *
 * `prisma.<model>.findFirst({ take: 1 })` **不带 `select`** 时，
 * Prisma 会选出该模型的**全部标量列**。因此任何一列在库里缺失都会触发
 * P2022 —— 不需要维护「新增了哪些列」的清单（那种清单一定会被漏更新，
 * 而且漏更新的那次恰好就是出事的这次）。
 *
 * `take: 1` 让代价降到一次索引扫描，启动时跑得起。
 *
 * ## 为什么只喊不拦
 *
 * 与 `capabilities.ts` 同一套理由：schema 漂移时**大多数页面仍然可用**
 * （只有碰了漂移列的那些会 500）。直接崩掉会把「部分页面不可用」
 * 升级成「整站不可用」，反而更糟。
 */

import { prisma } from "@/lib/prisma";

/**
 * 要被检查的模型。
 *
 * 选的是**页面主路径上会查的**模型 —— 这些一旦漂移就是整页 500，
 * 而不是某个角落功能不可用。加新模型时应当一并加进来。
 */
const CHECKED_MODELS = [
  "user",
  "collection",
  "subject",
  "episode",
  "danmaku",
  "danmakuReport",
  "emailVerification",
  "userFollow",
] as const;

/** Prisma 的「列不存在」错误码。 */
const COLUMN_MISSING = "P2022";

interface DriftReport {
  model: string;
  /** 缺失的列名（Prisma 在 `meta.column` 里给出）。 */
  column: string;
}

/** 从 Prisma 错误里尽量取出缺失的列名；取不到时返回空串。 */
function missingColumnOf(error: unknown): string {
  const meta = (error as { meta?: { column?: unknown } })?.meta;
  return typeof meta?.column === "string" ? meta.column : "";
}

/**
 * 能被查询的 Prisma 客户端。
 *
 * 形参化是为了**能被测试**：测试会在一个事务里临时删掉一列，再用同一个
 * 事务的客户端调这个函数 —— 用模块级的 `prisma` 会因为跑在另一条连接上
 * 而看不到未提交的 DDL，「永远检测不到漂移」这种坏法就没有断言能抓住。
 */
type QueryableClient = Record<string, { findFirst?: (args: unknown) => Promise<unknown> }>;

/**
 * 检查每个模型是否能被完整选出。
 *
 * 返回漂移清单 —— **不抛异常**：数据库连不上、权限不足等都不该让启动挂掉，
 * 那是另一类问题（有各自的日志），混在一起会让人分不清。
 */
export async function findSchemaDrift(client: unknown = prisma): Promise<DriftReport[]> {
  const drift: DriftReport[] = [];
  const source = client as QueryableClient;

  for (const model of CHECKED_MODELS) {
    const delegate = source[model];
    if (typeof delegate?.findFirst !== "function") continue;

    try {
      await delegate.findFirst({ take: 1 });
    } catch (error) {
      if ((error as { code?: string })?.code === COLUMN_MISSING) {
        drift.push({ model, column: missingColumnOf(error) });
      }
      // 其他错误（连接失败等）在这里静默 —— 不是这个检查的职责
    }
  }

  return drift;
}

let announced = false;

/**
 * 打印 schema 漂移警告。
 *
 * 只在**确实漂移**时打印（本检查有真实查询代价，正常情况下一句话都不说）。
 */
export async function announceSchemaDrift(
  log: (message: string) => void = console.error,
): Promise<void> {
  if (announced) return;
  announced = true;

  const drift = await findSchemaDrift();
  if (drift.length === 0) return;

  log("");
  log("================================================================");
  log("⛔ 数据库 schema 落后于代码 —— 这些模型的列在库里不存在：");
  for (const item of drift) {
    log(`   · ${item.model}${item.column ? ` → 缺列 ${item.column}` : ""}`);
  }
  log("");
  log("   后果：只要页面查了缺失的列，整个页面会 500（不是部分功能失效）。");
  log("");
  log("   原因通常是重建镜像时漏了 migrate —— 它跑的是旧 schema，");
  log("   `prisma db push` 因此会打印误导性的「already in sync」：");
  log("   那句话说的是「库与 migrate 镜像一致」，而 web 镜像是新代码。");
  log("");
  log("   修法（三个都构建，别只构建 web）：");
  log("     docker compose build migrate web gateway");
  log("     docker compose up -d");
  log("================================================================");
  log("");
}
