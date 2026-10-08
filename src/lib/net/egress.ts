import { connect, type Socket } from "node:net";

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
 * 允许重复打印。
 *
 * 给测试用 —— 与 `fetcher.ts` 的 `resetRateLimits()` 同一套理由：
 * 模块级去重会让第二个用例开始全部静默返回，断言退化成
 * 「什么都没发生也通过」。导出重置是为了让测试打**真实的**分支，
 * 而不是在测试里把分支逻辑抄一遍（抄一遍就测不到真东西）。
 */
export function resetEgressAnnouncement(): void {
  announced = false;
}

/** 探测函数：能否连上该地址。注入是为了让两种分支都能被测试。 */
export type ProxyProbe = (url: string) => Promise<boolean>;

/**
 * 有界 TCP 探测代理地址。
 *
 * ## 为什么必须真探一次
 *
 * 只看形态会**在这台开发机上误报** —— 它确实写着
 * `host.docker.internal:7897`，而本机真的跑着 Clash。一条每次启动都喊的
 * 警告会训练人忽略它，那比不喊更糟（这正是这个文件想避免的失效模式）。
 *
 * 只做 TCP 握手，不发 HTTP：目的是「这个地址后面有没有东西在听」，
 * 而不是「代理能不能出网」（后者是上游的可用性，抖动时误报没有意义）。
 * 超时 800ms —— 启动路径上的上限，不能拖慢启动。
 *
 * ## ⚠️ 已知局限：在 TUN 环境下只能可靠判断**环回**地址
 *
 * 若宿主机跑着 Clash/Mihomo 的 TUN（并且 `auto-route: true`），**任何非环回
 * TCP 连接都会被 TUN 在本地应答** —— 探测会对一个根本不存在的远端地址返回
 * `true`。实测：`10.255.255.1:9` 在 TUN 下「连得上」。
 *
 * 这不是理论问题：`tests/egress.test.ts` 里原本就用保留地址构造「不可达」，
 * 在本机把核心从 GUI 托管换成 systemd 托管之后该断言开始失败，才暴露出这点。
 *
 * 好在探测**只对开发机地址运行**（`egressShape` 判定为 `dev-proxy` 时），
 * 而那几类里 `127.0.0.1` / `localhost` 是环回、不受 TUN 影响 ——
 * 正是最需要拦住的情况（服务器上那个端口没人监听）。
 * `host.docker.internal` 不是环回，可能被 TUN 掩盖，这一点是接受的：
 * 那种误判只会少喊一次警告，不会拦错东西。
 */
export function probeProxyReachable(url: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    let socket: Socket;
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
      // `host.docker.internal` 在容器里可能解析不了 —— 那正是我们要报的情况
      socket = connect({ host: parsed.hostname, port });
    } catch {
      // 地址本身不合法（例如 `不是个 URL`）—— 按不可达处理
      resolve(false);
      return;
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 打印出站代理形态。
 *
 * | 形态 | 代理可达 | 输出 |
 * |---|---|---|
 * | 直连 | — | 一行 `[egress] 出站直连` |
 * | 配了代理 | 是 | 一行 `[egress] 出站经代理 …` |
 * | 配了代理 | **否** | 一段警告 + 处置办法 |
 *
 * 每次启动都打印（正常情况也打）—— 这条信息在排查网络问题时是第一手
 * 资料，事后去猜「当时到底走没走代理」比多打一行昂贵得多。
 */
export async function announceEgress(
  probe: ProxyProbe = (url) => probeProxyReachable(url),
  log: (message: string) => void = console.warn,
): Promise<void> {
  if (announced) return;
  announced = true;

  const shape = egressShape();

  if (shape.kind === "direct") {
    log("[egress] 出站直连（未配置代理）");
    return;
  }

  /*
   * **一律真探一次再决定喊不喊** —— 显式配的代理连不上，后果与
   * 「本机代理被带到服务器」完全相同（所有外部请求失败，症状像代码 bug），
   * 所以不能只对 `host.docker.internal` 报警。
   */
  if (await probe(shape.url)) {
    log(`[egress] 出站经代理 ${shape.url}（可达）`);
    return;
  }

  if (shape.kind === "proxy") {
    // 显式配置的代理：处置办法是「去查那台代理」，不是「删掉这个变量」
    log("");
    log("================================================================");
    log(`⚠️  出站代理连不上：${shape.url}`);
    log("");
    log("   容器里所有外部请求（BGM / 弹幕源 / 媒体源）都会失败，");
    log("   而症状与「代码有 bug」完全相同。");
    log("");
    log("   这不是「本机开发地址」那类误配 —— 该地址是显式配置的，");
    log("   请确认代理真的在运行、且从这个网络能连上它。");
    log("================================================================");
    log("");
    return;
  }

  log("");
  log("================================================================");
  log("⚠️  出站代理指向本机开发地址，且探不通：");
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
