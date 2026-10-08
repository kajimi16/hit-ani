/**
 * 出站代理配置检查 —— 启动时喊出来。
 *
 * ## 为什么必须检查
 *
 * `docker-compose.yml` 把 `HTTP_PROXY` / `HTTPS_PROXY` 透给容器，并设
 * `NODE_USE_ENV_PROXY=1`。这个组合**在本机是必需的**（Clash 只监听宿主
 * `127.0.0.1`，容器里的 `127.0.0.1` 是它自己，所以要靠 `proxy` 服务转发）。
 *
 * 但 `.env` 是要**整份复制到服务器**的（里面有 `SESSION_SECRET`、SMTP 凭据
 * 这些必须跟着走的东西）。于是最容易发生的事故是：
 *
 *   服务器上没有 Clash → 容器往一个不存在的代理发请求 → BGM / Animeko /
 *   dandanplay **全部** `fetch failed`，探索页显示「Bangumi 搜索失败」。
 *
 * 而症状与「代码有 bug」**完全一样**，`NODE_USE_ENV_PROXY=1` 还让 `curl`
 * 能通、应用不通，进一步把人往错误方向引（实测踩过）。
 *
 * 因为失败方式是最难查的那种，所以在这里主动喊 —— 与 `capabilities.ts`
 * 同一套理由：**让日志说话，而不是让用户替我们发现**。
 *
 * ## 关于「喊哪一种」
 *
 * 只检查**配置形态**（设了没设、指向哪里），不做真实连通性探测：
 * 启动时发网络请求会让启动变慢且可能因上游抖动误报，而这两种情况的
 * 处置方式完全不同（前者是配置错，后者是网络抖动）——混在一起喊
 * 会训练人忽略这条日志。
 */

/** 出站代理的当前形态。 */
export type EgressShape =
  /** 没配代理，容器直连 —— 校内服务器应当是这个。 */
  | { kind: "direct" }
  /** 配了代理，指向本机开发用地址。 */
  | { kind: "dev-proxy"; url: string }
  /** 配了代理，指向别处（自建代理等）。 */
  | { kind: "proxy"; url: string };

/**
 * 判定代理形态。
 *
 * 只看 `HTTP_PROXY`（`HTTPS_PROXY` 由 compose 用同一个变量赋值，两处
 * 各判一次只会有两个可能不一致的结论）。
 */
export function egressShape(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EgressShape {
  // 空字符串等同未设置 —— compose 里用 `${VAR-}` 就是为了产出这个形态
  const url = env.HTTP_PROXY?.trim();
  if (!url) return { kind: "direct" };

  /*
   * `host.docker.internal` 在**本机开发**里是必需的（指向宿主回环上的
   * Clash），而在服务器上它几乎必然是个死地址 —— 宿主的 `/etc/hosts` 里
   * 通常没有这条记录（Docker Desktop 才会自动注入）。
   *
   * 因此把它单独识别出来：这是「.env 从开发机复制过来」的指纹。
   */
  // 小写比较：`HOST.DOCKER.INTERNAL` 也是同一个地址，漏了它这条检查就白写
  const lower = url.toLowerCase();
  if (
    lower.includes("host.docker.internal") ||
    lower.includes("127.0.0.1") ||
    lower.includes("localhost")
  ) {
    return { kind: "dev-proxy", url };
  }
  return { kind: "proxy", url };
}

let announced = false;

/**
 * 打印出站代理形态。
 *
 * 每次启动都打印（`kind: "proxy"` 也打）—— 这条信息在排查网络问题时
 * 是第一手资料，事后去猜「当时到底走没走代理」比多打一行昂贵得多。
 */
export function announceEgress(log: (message: string) => void = console.warn): void {
  if (announced) return;
  announced = true;

  const shape = egressShape();

  if (shape.kind === "direct") {
    log("[egress] 出站直连（未配置代理）");
    return;
  }

  if (shape.kind === "proxy") {
    log(`[egress] 出站经代理 ${shape.url}`);
    return;
  }

  log("");
  log("================================================================");
  log("⚠️  出站代理指向本机开发地址：");
  log(`   HTTP_PROXY=${shape.url}`);
  log("");
  log("   容器里的 127.0.0.1 是它自己，host.docker.internal 在宿主");
  log("   /etc/hosts 里通常也没有条目 —— 除非这台机器上真的跑着");
  log("   代理，否则 BGM / 弹幕源 / 媒体源会全部 fetch failed，");
  log("   症状与「代码有 bug」完全相同。");
  log("");
  log("   校内服务器部署时应把 .env 里的 HTTP_PROXY_URL 留空");
  log("   （服务器上的 .env 多半是从开发机整份复制过去的）。");
  log("   确认方法：docker compose config | grep -iE 'proxy|profile'");
  log("================================================================");
  log("");
}
