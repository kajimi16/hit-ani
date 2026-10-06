/**
 * 从请求头取出「来源 IP」，用于限流。
 *
 * ## ⚠️ 这个值**不可信**，不能作为唯一防线
 *
 * Next 的路由处理器拿不到 socket 地址，只能读 `X-Forwarded-For`；而实测确认
 * **Next 会直接透传客户端发的这个头** —— 伪造 `9.9.9.1` 后服务端看到的就是
 * `9.9.9.1`，没有任何追加的真实地址。
 *
 * 后果：任何**只**按这个值限流的接口都能被一条 header 绕过
 * （实测：不伪造时第 6 次被拦，伪造后连续 8 次全过）。
 * 因此调用方必须另有**与请求头无关**的兜底限流。
 *
 * ## 取第一跳还是最后一跳
 *
 * 取**最后一跳**：
 * - 直连（客户端没发这个头时由 Next 从 socket 填）→ 只有一个值，取谁都一样；
 * - 一层可信代理（代理把自己的对端地址**追加**在后面）→ 最后一个是真实客户端；
 * - 客户端伪造时（`<伪造>, <真实>`）→ 最后一个是真实的，伪造值被挤到前面。
 *
 * 若取第一跳，上面第三种情况下拿到的是伪造值 —— 这正是可被绕过的原因。
 *
 * 局限：两层以上代理时最后一个是内层代理地址，会让所有用户共用一个限流键。
 * 那需要按「可信代理层数」取对应位置；本项目是单容器直连，不涉及。
 */
export function clientIp(headers: {
  get(name: string): string | null;
}): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    // 取最后一跳 —— 见上方说明
    if (hops.length > 0) return hops[hops.length - 1]!;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}
