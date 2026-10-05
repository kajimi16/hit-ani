/**
 * 全局加载骨架。
 *
 * 为什么是骨架而不是转圈：Animeko 全站没有转圈加载态，它一律用
 * `Modifier.placeholder` 画**几何对齐**的占位块 —— 内容到位时布局不跳。
 * 转圈则是把「等待」单独做成一个界面，内容一到位整页重排。
 *
 * 为了不跳，这里的占位块用的就是真实网格的类（`.subject-grid` +
 * `.skeleton-cover`），因此列数、间距、9:16 比例都与加载完成后一致。
 */
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="加载中">
      {/* 标题占位 */}
      <div className="space-y-3">
        <div className="skeleton h-8 w-40" />
        <div className="skeleton h-4 w-72" />
        <div className="skeleton h-10 w-full" />
      </div>

      {/* 区块标题占位 */}
      <div className="space-y-3">
        <div className="skeleton h-7 w-28" />
        <div className="subject-grid">
          {Array.from({ length: 18 }, (_, index) => (
            <div key={index} className="skeleton skeleton-cover" />
          ))}
        </div>
      </div>

      <span className="sr-only">加载中…</span>
    </div>
  );
}
