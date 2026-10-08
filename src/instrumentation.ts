/**
 * 启动钩子（Next.js `instrumentation.ts`）。
 *
 * ## 为什么需要它
 *
 * `capabilities.ts` 的文档写着「部署后 `docker compose logs web` 应当能直接
 * 看出注册能不能用」—— 但那份实现只在 **register / send-code 两个请求处理器**
 * 里被调用。结果是：部署后日志**干干净净**，直到第一个用户点「注册」撞上
 * 503 才发现邮件没配。文档与行为不一致，而失败方式恰好是最糟的那种
 * （让用户替我们发现问题）。
 *
 * `instrumentation.ts` 的 `register()` 在**服务端进程启动时执行一次**，
 * 正是这个检查该待的地方。文件必须放在 `src/` 下（本项目用了 `src/app`）。
 *
 * ## 为什么是警告而不是让进程退出
 *
 * 邮件未配置时**注册不可用**，但浏览、追番、弹幕、时光机全都正常 ——
 * 直接崩掉会把「部分功能不可用」升级成「整站不可用」。因此只喊，不拦。
 */

import { announceCapabilities } from "@/lib/email/capabilities";
import { announceEgress } from "@/lib/net/egress";
import { announceSchemaDrift } from "@/lib/db/schema-drift";

export async function register(): Promise<void> {
  /*
   * 只在 Node 运行时执行。
   *
   * Edge runtime 里 `process.env` 的视图不完整，而且没有容器日志可写 ——
   * 在那里检查会给出误导性的「未配置」结论。
   */
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  announceCapabilities();
  /*
   * 出站代理形态。理由与上面同一套（日志说话，别让用户替我们发现），
   * 但这一条尤其重要：**代理配错会让所有外部请求失败，而症状与代码 bug
   * 一模一样**。见 `src/lib/net/egress.ts`。
   */
  await announceEgress();

  /*
   * schema 漂移。**必须 await** —— 不 await 的话进程可能在查询返回前就
   * 进入服务状态，警告会出现在日志的另一处，甚至来不及打印。
   *
   * 放在最后：它要连数据库，是最慢的一项，而上面两项是纯内存判断。
   */
  await announceSchemaDrift();
}
