/**
 * OAuth 回调结果的展示映射。
 *
 * ## 为什么需要这个模块
 *
 * 绑定 QQ / Bangumi 是**跳转式** OAuth：用户离开本站去授权页，再被整页重定向
 * 回来。回调路由只能把结果放进 URL（`?bgm=ok|failed|taken|denied&reason=…`）。
 *
 * 这些参数此前**没有任何消费者** —— 设置页没读 `searchParams`，于是用户被送回
 * 设置页却看不到任何反馈：绑定成功了不知道成功，失败了也不知道为什么。绑定
 * 冲突（同一 BGM 账号已被另一个本地账号占用）尤其糟，本站明明有能力说清原因。
 *
 * 抽成纯函数是为了能直接测「用户到底看到什么」，而不必去跑一遍 OAuth。
 */

/** 回调可能带回来的状态。`ok` 之外的都值得显示。 */
export type OAuthOutcome = "ok" | "failed" | "taken" | "denied";

export interface OAuthNotice {
  /** 展示级别：成功用 tertiary、可自愈的用 secondary、被拒绝用 error。 */
  tone: "success" | "warn" | "error";
  title: string;
  /** 附加说明，可能为空。 */
  detail: string | null;
}

interface RawParams {
  bgm?: string;
  qq?: string;
  reason?: string;
}

const SERVICE_LABELS = { bgm: "Bangumi", qq: "QQ" } as const;

/**
 * 把回调参数翻译成要显示的提示；无可显示内容时返回 `null`。
 *
 * 两件事要留意：
 * - **`reason` 来自 URL，是不可信输入**，这里只做长度截断，不给它任何结构；
 * - 出现的顺序固定为 `bgm` 先于 `qq` —— 两个绑定不会同时发生，但顺序固定能
 *   避免「同时带上两个参数时提示随机变化」。
 */
export function describeOAuthResult(params: RawParams): OAuthNotice | null {
  for (const service of ["bgm", "qq"] as const) {
    const raw = params[service];
    if (!raw) continue;

    const label = SERVICE_LABELS[service];
    const reason = sanitizeReason(params.reason);

    if (raw === "ok") {
      return { tone: "success", title: `${label} 绑定成功。`, detail: null };
    }

    if (raw === "taken") {
      return {
        tone: "warn",
        title: `这个 ${label} 账号已经绑定到本站的另一个账号了。`,
        detail:
          service === "bgm"
            ? "如果你就是该账号的主人，可以在下方用「个人访问令牌」重新绑定，届时会让你确认是否把绑定迁移到当前账号。"
            : "请先在那个账号里解除绑定，再回来重试。",
      };
    }

    if (raw === "denied") {
      return {
        tone: "warn",
        title: `${label} 授权被拒绝。`,
        detail: reason ?? "你在授权页面取消了授权。",
      };
    }

    return {
      tone: "error",
      title: `${label} 绑定失败。`,
      detail: reason ?? "上游没有返回具体原因，可以稍后重试。",
    };
  }

  return null;
}

/**
 * 清洗回传到 URL 里的原因文本。
 *
 * 它是**不可信输入**（可以被任何人构造链接塞进来），因此：
 * - 去掉控制字符与换行，避免撑破布局；
 * - 截断到合理长度；
 * - 空串按「没有原因」处理。
 *
 * 这里不做转义 —— React 渲染文本时已经转义，额外的转义只会让 `&amp;`
 * 这类字符显示错。
 */
function sanitizeReason(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}
