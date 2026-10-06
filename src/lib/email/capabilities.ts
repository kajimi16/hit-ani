/**
 * 部署能力自检。
 *
 * ## 为什么需要它
 *
 * 注册**强制**要求邮箱验证码（用户明确选择）。这意味着：**邮件传输没配好，
 * 就等于任何人都无法注册** —— 而这不会在部署时暴露，只会在第一个用户
 * 尝试注册时表现为「收不到验证码」。
 *
 * 这类「配置缺失导致功能整体不可用」的问题，必须在**启动时**就喊出来，
 * 而不是等用户来报。
 *
 * ## 与「降级」的区别
 *
 * 这里**不做降级**：用户选择的是「强制验证」，未配置时放行注册等于
 * 悄悄撤掉那道防线。因此本模块只做两件事：
 * 1. 让服务端日志在启动时明确警告；
 * 2. 让接口与界面给出**可操作的**诊断（缺哪个变量、去哪儿配）。
 */

import { isEmailConfigured } from "@/lib/email/transport";

export interface CapabilityReport {
  /** 邮件发送是否可用。不可用时**注册功能整体不可用**。 */
  email: boolean;
  /** 问题清单（空数组表示无问题）。 */
  problems: string[];
}

/**
 * 检查部署的关键能力。
 *
 * 调用时机：注册接口、发码接口的**入口**，以及（可选）进程启动时。
 * 放在请求入口而不是只在启动时，是因为环境变量可能在容器重启后变化 ——
 * 每次都查一遍的成本只是几个 `process.env` 读取。
 */
export function checkCapabilities(): CapabilityReport {
  const problems: string[] = [];
  const email = isEmailConfigured();

  if (!email) {
    problems.push(
      "未配置邮件发送（SMTP_HOST 与 EMAIL_API_URL 都为空）—— 注册功能不可用。" +
        "请在 .env 中配置其中之一后重启 web 容器。",
    );
  }

  return { email, problems };
}

/**
 * 启动时打印一次能力状态。
 *
 * 只在服务端首次导入时执行（用模块级标志防重复）。日志是**运维的第一道
 * 防线** —— 部署后 `docker compose logs web` 应当能直接看出「注册能不能用」。
 */
let announced = false;

export function announceCapabilities(log: (message: string) => void = console.warn): void {
  if (announced) return;
  announced = true;

  const report = checkCapabilities();
  if (report.problems.length === 0) return;

  log("");
  log("================================================================");
  log("⚠️  部署能力检查发现问题：");
  for (const problem of report.problems) log(`   · ${problem}`);
  log("================================================================");
  log("");
}
