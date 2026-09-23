/**
 * 外部弹幕的「量级设防」单测。
 *
 * ## 为什么必须测这个
 *
 * 实测 dandanplay 单集返回 **4920 条**（约 1 MB）。这类问题在功能测试里
 * **完全看不出来** —— 接口 200、数据正确、弹幕也显示。只有专门的量级断言能挡住。
 *
 * 本项目踩过两次：
 *  1. 只对本地弹幕应用 `limit`，外部弹幕全量展开 → `?limit=100` 返回 4920 条
 *  2. 修了截断后，`totalAvailable` 报的却是**截断后**的数字 →
 *     用户看到「共 3000 条」（实际 4909），且截断日志永不触发
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CACHED_EPISODES,
  MAX_DANMAKU_PER_SOURCE,
  clearExternalCache,
  externalCacheEvictions,
  externalCacheSize,
  fetchExternalDanmaku,
} from "@/lib/danmaku/external";
import { clearDanmakuCache } from "@/lib/danmaku/cache-repository";
import { DANMAKU_LIMITS } from "@/lib/danmaku/types";

const REAL_FETCH = globalThis.fetch;

/** 造一个含 `count` 条弹幕的 Animeko 响应。 */
function stubAnimeko(count: number): void {
  globalThis.fetch = (async () => {
    const danmakuList = Array.from({ length: count }, (_, i) => ({
      id: `d${i}`,
      senderId: "u1",
      danmakuInfo: {
        playTime: i * 100,
        color: -1,
        text: `弹幕 ${i}`,
        location: "NORMAL",
      },
    }));
    return new Response(JSON.stringify({ danmakuList }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

async function withStub(fn: () => Promise<void>): Promise<void> {
  try {
    // 两级缓存都要清：内存 LRU + **数据库**。只清内存会让上个用例的
    // 持久化缓存命中本用例 —— 实测踩过（stub 返回 5000 条却读到 4909）。
    await clearDanmakuCache();
    clearExternalCache();
    await fn();
  } finally {
    globalThis.fetch = REAL_FETCH;
    clearExternalCache();
    await clearDanmakuCache();
  }
}

/* ---------------------------------------------------------------- *
 * 常量取值
 * ---------------------------------------------------------------- */

test("单源上限足以覆盖正常观看窗口，又能挡住极端量", () => {
  assert.equal(MAX_DANMAKU_PER_SOURCE, 3000);
  assert.ok(MAX_DANMAKU_PER_SOURCE < 4900, "必须低于实测的 4920 条");
  assert.ok(MAX_DANMAKU_PER_SOURCE > 2000, "不能低于正常集数的弹幕量");
});

test("缓存集数上限 × 单集体积后内存可控", () => {
  const MB_PER_EPISODE = 0.92; // 实测值
  const estimatedMB = MAX_CACHED_EPISODES * MB_PER_EPISODE;
  assert.ok(estimatedMB < 64, `约 ${estimatedMB.toFixed(0)} MB，超出合理范围`);
});

test("默认拉取上限不超过单源上限（否则限了等于没限）", () => {
  assert.ok(DANMAKU_LIMITS.defaultLimit <= MAX_DANMAKU_PER_SOURCE);
});

/* ---------------------------------------------------------------- *
 * 截断行为
 * ---------------------------------------------------------------- */

test("单源返回量超过上限时被截断", async () => {
  await withStub(async () => {
    stubAnimeko(5000);
    const result = await fetchExternalDanmaku({ episodeId: 1 });

    assert.equal(result.items.length, MAX_DANMAKU_PER_SOURCE, "应被截断到上限");
    assert.ok(result.items.length < 5000);
  });
});

test("★ totalAvailable 报的是截断**前**的真实总数", async () => {
  // 这是修过的 bug：早先 `totalAvailable = items.length`，
  // 而 items 已经截断过 —— 于是 4909 条会显示「共 3000 条」。
  await withStub(async () => {
    stubAnimeko(4909);
    const result = await fetchExternalDanmaku({ episodeId: 1 });

    assert.equal(result.totalAvailable, 4909, "必须是真实总数，不是截断后的长度");
    assert.equal(result.items.length, MAX_DANMAKU_PER_SOURCE);
    assert.ok(
      result.totalAvailable > result.items.length,
      "真实总数应大于实际返回数 —— 界面据此提示「已显示前 N 条」",
    );
  });
});

test("调用方指定的 maxItems 优先于默认上限", async () => {
  await withStub(async () => {
    stubAnimeko(5000);
    const result = await fetchExternalDanmaku({ episodeId: 1, maxItems: 100 });

    assert.equal(result.items.length, 100, "应按调用方的 limit 截断");
    assert.equal(result.totalAvailable, 5000, "真实总数不受 limit 影响");
  });
});

test("未超上限时不截断，且 totalAvailable 等于实际条数", async () => {
  await withStub(async () => {
    stubAnimeko(50);
    const result = await fetchExternalDanmaku({ episodeId: 1 });

    assert.equal(result.items.length, 50);
    assert.equal(result.totalAvailable, 50);
  });
});

test("截断保留时间轴最前面的一段（而非随机砍）", async () => {
  await withStub(async () => {
    stubAnimeko(5000);
    const result = await fetchExternalDanmaku({ episodeId: 1, maxItems: 10 });

    assert.deepEqual(
      result.items.map((d) => d.playTimeMs),
      [0, 100, 200, 300, 400, 500, 600, 700, 800, 900],
      "应保留最早的 10 条",
    );
  });
});

/* ---------------------------------------------------------------- *
 * 缓存
 * ---------------------------------------------------------------- */

test("缓存命中时仍带真实总数（否则总数会从 4909 掉成 3000）", async () => {
  await withStub(async () => {
    stubAnimeko(4909);

    const first = await fetchExternalDanmaku({ episodeId: 42 });
    assert.equal(first.totalAvailable, 4909);

    // 第二次应命中缓存 —— 总数不能丢
    const second = await fetchExternalDanmaku({ episodeId: 42 });
    assert.equal(second.totalAvailable, 4909, "缓存命中时真实总数必须保留");
    assert.equal(second.items.length, first.items.length);
  });
});

test("缓存有容量上限，不会随访问集数无界增长", async () => {
  await withStub(async () => {
    stubAnimeko(10);

    for (let i = 0; i < MAX_CACHED_EPISODES + 15; i += 1) {
      await fetchExternalDanmaku({ episodeId: i });
    }

    assert.equal(
      externalCacheSize(),
      MAX_CACHED_EPISODES,
      `缓存应稳定在上限 ${MAX_CACHED_EPISODES}，实际 ${externalCacheSize()}`,
    );
    assert.ok(externalCacheEvictions() > 0, "应有淘汰发生");
  });
});
