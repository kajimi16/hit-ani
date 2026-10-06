import Link from "next/link";

/**
 * 全局 404。
 *
 * ## 为什么必须有
 *
 * 此前用的是 **Next 的默认 404 页**：英文 `404: This page could not be found.`，
 * 没有导航、没有品牌、没有任何出口（实测确认）。学生会从聊天记录里点到一个
 * 已被删除的条目链接，然后看到一句英文 —— 不知道是本平台的问题、还是自己
 * 点错了，也不知道下一步该干什么。
 *
 * ## 为什么不显示「要搜索的内容」
 *
 * 这里**不渲染搜索框**：404 对同一个 URL 的内容应当稳定，而搜索框在 404 上
 * 没有明确语义（搜什么？刚才那个失败的 id 吗？）。给两个明确的出口更实在：
 * 回探索页、或去找番。
 */
export default function NotFound() {
  return (
    <div className="animate-rise mx-auto max-w-lg space-y-4 py-16 text-center">
      <p className="font-mono text-sm text-on-surface-variant">404</p>
      <h1 className="text-2xl font-normal">这一页不存在</h1>
      <p className="text-sm text-on-surface-variant">
        可能是链接过期了，或者条目已被删除。
      </p>

      <div className="flex flex-wrap justify-center gap-3 pt-2">
        <Link href="/" className="btn btn-primary">
          回到探索
        </Link>
        <Link href="/library" className="btn btn-ghost">
          我的追番
        </Link>
      </div>
    </div>
  );
}
