/**
 * 授予 / 撤销管理员。
 *
 * 用法：
 *   npx tsx scripts/admin-grant.ts <邮箱或学号>          # 授予
 *   npx tsx scripts/admin-grant.ts <邮箱或学号> --revoke  # 撤销
 *   npx tsx scripts/admin-grant.ts --list                # 列出当前管理员
 *
 * ## 为什么是脚本而不是「首个账号自动成为管理员」
 *
 * 那条规则看起来更省事，但本库的第一个用户是**种子账号 alice** ——
 * 自动授予会直接违背「种子账号绝不可用于生产」。
 *
 * 而且显式授予是**可审计**的：谁在什么时候拿到了管理员权限，有一条
 * 明确的命令记录；自动规则则取决于「谁先注册」这种偶然事实。
 *
 * 环境变量 `ADMIN_EMAILS` 仍然是另一个来源，两者取并集（见 session.ts）。
 * 本脚本改的是 DB 里的 `User.isAdmin`，不需要重启服务。
 */
import { prisma } from "../src/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith("--"));
  const target = args.find((a) => !a.startsWith("--"));

  if (flags.includes("--list")) {
    const admins = await prisma.user.findMany({
      where: { isAdmin: true },
      select: { email: true, nickname: true, schoolId: true },
      orderBy: { email: "asc" },
    });
    const envList = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    console.log(`  DB 授予的管理员（${admins.length}）:`);
    for (const a of admins) console.log(`    ${a.nickname} <${a.email}> ${a.schoolId}`);
    console.log(`  ADMIN_EMAILS 环境变量（${envList.length}）: ${envList.join(", ") || "（空）"}`);
    return;
  }

  if (!target) {
    console.error("用法: admin-grant.ts <邮箱或学号> [--revoke] | --list");
    process.exitCode = 1;
    return;
  }

  // 邮箱或学号都能定位 —— 与登录的 identifier 口径一致
  const user = await prisma.user.findFirst({
    where: { OR: [{ email: target.toLowerCase() }, { studentNo: target }] },
    select: { id: true, email: true, nickname: true, isAdmin: true },
  });
  if (!user) {
    console.error(`  找不到账号：${target}`);
    process.exitCode = 1;
    return;
  }

  const revoke = flags.includes("--revoke");
  if (user.isAdmin === !revoke) {
    console.log(`  ${user.nickname} <${user.email}> 已是${revoke ? "普通用户" : "管理员"}，无需变更`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { isAdmin: !revoke } });
  console.log(`  ${revoke ? "已撤销" : "已授予"}管理员：${user.nickname} <${user.email}>`);
  console.log("  （无需重启服务，下一次请求即生效）");
}

void main().finally(() => prisma.$disconnect());
