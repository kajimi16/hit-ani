import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    /**
     * Bangumi 封面全部经由本站 `/_next/image` 代理并缓存。
     * 不直接热链 lain.bgm.tv：
     * - 避免把校内用户 IP 暴露给第三方
     * - 避免上游限制 referer / 限速导致封面大面积裂图
     * - 服务端统一缓存，节省校内带宽
     */
    remotePatterns: [
      { protocol: "https", hostname: "lain.bgm.tv", pathname: "/**" },
      { protocol: "https", hostname: "bgm.tv", pathname: "/**" },
    ],
    // 封面变动极少，长缓存
    minimumCacheTTL: 60 * 60 * 24 * 7,
  },
};

export default nextConfig;
