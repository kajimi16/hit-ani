import { checkCapabilities } from "@/lib/email/capabilities";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import RegisterForm from "@/components/register-form";

export const dynamic = "force-dynamic";

export const metadata = { title: "注册" };

/**
 * 注册页（**服务端组件**）。
 *
 * ## 为什么能力判断必须在这里做
 *
 * 邮件未配置时**注册整体不可用**（验证码是必填的）。若把判断放到客户端
 * （`useEffect` 里取接口），首屏会先渲染出**可填的表单**，水合后才被替换成
 * 说明 —— 用户可能已经开始输入。实测确认过这个首屏闪烁。
 *
 * 放在服务端组件里，首屏 HTML 就是正确的：要么是表单，要么是说明。
 * 顺带省掉一次客户端请求（学校白名单也一并在这里取好）。
 *
 * ## 不做「未配置就放行注册」的降级
 *
 * 用户明确选择的是**强制验证**。未配置就放行等于把他选的那道防线悄悄撤掉，
 * 而注册页看起来一切正常 —— 那比明确的「暂不可用」糟得多。
 */
export default async function RegisterPage() {
  const [schools, capabilities] = await Promise.all([
    prisma.school.findMany({
      select: { id: true, name: true, domains: true },
      orderBy: { id: "asc" },
    }),
    Promise.resolve(checkCapabilities()),
  ]);

  if (!capabilities.email) {
    return (
      <div className="mx-auto max-w-sm space-y-6">
        <h1 className="text-2xl font-semibold">注册</h1>

        <div className="alert alert-danger space-y-2 text-sm">
          <p className="font-medium">本部署暂未启用邮箱验证，因此无法注册。</p>
          <p className="text-xs">{capabilities.problems[0] ?? "邮件发送未配置。"}</p>
          <p className="text-xs">
            这是服务端配置问题，不是你的操作问题。填表也无法完成注册，
            因此表单已暂时收起 —— 请联系管理员配置邮件发送后重试。
          </p>
        </div>

        <p className="text-center text-sm text-on-surface-variant/70">
          已有账号？
          <Link href="/login" className="ml-1 text-primary underline">
            登录
          </Link>
          <span className="mx-2 text-outline">·</span>
          <Link href="/" className="text-primary underline">
            先随便看看
          </Link>
        </p>
      </div>
    );
  }

  return <RegisterForm schools={schools} />;
}
