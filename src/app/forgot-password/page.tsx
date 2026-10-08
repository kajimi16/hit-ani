import type { Metadata } from "next";
import ForgotPasswordForm from "@/components/forgot-password-form";

export const metadata: Metadata = { title: "找回密码" };

/**
 * 忘记密码。
 *
 * 服务端组件只渲染外壳；表单逻辑在客户端（两步式，且要在成功后跳转）。
 */
export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto max-w-sm space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">找回密码</h1>
        <p className="text-sm text-on-surface-variant">
          用注册时的学校邮箱接收验证码，验证通过后设置新密码。
        </p>
      </div>

      <ForgotPasswordForm />
    </div>
  );
}
