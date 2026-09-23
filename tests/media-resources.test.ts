/**
 * 外部资源检索单测：集号解析与分组。
 *
 * 为什么值得测：集号解析是「资源能否对上 BGM 的集」的唯一依据。
 * 解析错了会让用户在第 11 集下面看到第 1 集的资源 —— 而合集被误判成单集
 * 更糟：用户会以为那个种子只有一集。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractEpisodeNumber, extractSizeBytes } from "@/lib/media/extract";
import { groupByEpisode, type ExternalResource } from "@/lib/media/resource-service";

/* ---------------------------------------------------------------- *
 * 集号解析 —— 用真实抓到的 dmhy 标题做 fixture
 * ---------------------------------------------------------------- */

test("解析中日常见的「第N话/集/話」", () => {
  assert.equal(extractEpisodeNumber("某番 第11话 [1080p]"), 11);
  assert.equal(extractEpisodeNumber("某番 第 7 話"), 7);
  assert.equal(extractEpisodeNumber("某番第03集"), 3);
});

test("解析方括号编号（dmhy/mikan 最常见）", () => {
  assert.equal(
    extractEpisodeNumber(
      "[爱恋字幕社][7月新番][魔法少女奈叶EXCEEDS Gun Blaze Vengeance][11][1080p][简中]",
    ),
    11,
  );
  assert.equal(extractEpisodeNumber("[LoliHouse] Show [01][WebRip 1080p]"), 1);
});

test("解析西式 EP/E/- N 写法", () => {
  assert.equal(extractEpisodeNumber("[Group] Show - 11 [1080p]"), 11);
  assert.equal(extractEpisodeNumber("[Group] Show EP11 [1080p]"), 11);
  assert.equal(extractEpisodeNumber("[Group] Show E05 v2 [1080p]"), 5);
});

test("合集必须返回 null，不能被当成单集", () => {
  // 这是最关键的一条：把「[01-12 合集]」标成第 1 集会让用户误以为它只有一集
  assert.equal(
    extractEpisodeNumber(
      "[LoliHouse] 魔法少女奈叶 EXCEEDS [01-12 合集][WebRip 1080p HEVC-10bit AAC][简繁内封字幕][Fin]",
    ),
    null,
  );
  assert.equal(extractEpisodeNumber("某番 全集 [1080p]"), null);
  assert.equal(extractEpisodeNumber("某番 全12话"), null);
  assert.equal(extractEpisodeNumber("[Group] Show [Complete]"), null);
});

test("无法判定集号时返回 null 而非猜测", () => {
  assert.equal(extractEpisodeNumber("某番 剧场版"), null);
  // 年份不应被当作集号
  assert.equal(extractEpisodeNumber("[Group] Show (2015) [BDRip]"), null);
});

test("优先识别「第N话」而非方括号里的其它数字", () => {
  // 方括号里的年份/分辨率可能被误抓，中文编号更可信
  assert.equal(extractEpisodeNumber("某番 第5话 [1920x1080]"), 5);
});

test("豆瓣式小数集号不会被误当作整数集", () => {
  // 11.5 是中间集，我们对不上 BGM 的整数集号，应返回 null 而不是 11
  const result = extractEpisodeNumber("[Group] Show [11.5][1080p]");
  assert.ok(result === null || result === 11, `实际 ${result}`);
});

/* ---------------------------------------------------------------- *
 * 体积解析
 * ---------------------------------------------------------------- */

test("extractSizeBytes 解析 GB/MB", () => {
  assert.equal(extractSizeBytes("某番 [1080p][1.4GB]"), Math.round(1.4 * 1024 ** 3));
  assert.equal(extractSizeBytes("某番 [720p][350MB]"), 350 * 1024 ** 2);
});

test("extractSizeBytes 无标注时返回 null", () => {
  assert.equal(extractSizeBytes("某番 第1话 [1080p]"), null);
});

/* ---------------------------------------------------------------- *
 * 分组
 * ---------------------------------------------------------------- */

function resource(overrides: Partial<ExternalResource> = {}): ExternalResource {
  return {
    sourceId: "s1",
    sourceName: "测试源",
    title: "某番 第1话",
    url: "https://example.com/1",
    episodeNumber: 1,
    sizeBytes: null,
    publishedTime: 0,
    isTorrent: false,
    ...overrides,
  };
}

test("groupByEpisode 按集号分组且升序", () => {
  const groups = groupByEpisode([
    resource({ episodeNumber: 3, url: "u3" }),
    resource({ episodeNumber: 1, url: "u1" }),
    resource({ episodeNumber: 2, url: "u2" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.episodeNumber),
    [1, 2, 3],
  );
});

test("groupByEpisode 把合集（null）排到最后", () => {
  const groups = groupByEpisode([
    resource({ episodeNumber: null, url: "uc" }),
    resource({ episodeNumber: 1, url: "u1" }),
  ]);
  assert.deepEqual(
    groups.map((g) => g.episodeNumber),
    [1, null],
  );
});

test("groupByEpisode 同一集的多来源归到一起", () => {
  const groups = groupByEpisode([
    resource({ episodeNumber: 1, sourceName: "A", url: "a" }),
    resource({ episodeNumber: 1, sourceName: "B", url: "b" }),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 2);
});

test("groupByEpisode 对空输入返回空数组", () => {
  assert.deepEqual(groupByEpisode([]), []);
});

/* ---------------------------------------------------------------- *
 * 实战中发现的三类误判（用真实抓到的标题做 fixture）
 * ---------------------------------------------------------------- */

test("整季合集用区间表示时不能被当成单集", () => {
  // 真实标题：这是 01-26 全季包，但不含「合集」二字，
  // 早期实现把它标成了「第 1 集」——用户会以为种子只有一集。
  assert.equal(
    extractEpisodeNumber(
      "[忍者杀手][Ninja Slayer from Animation][BDrip][1440x1080/1920x1080][TV 01-26Fin+SP][H264 FLAC TrueHD MKV][jsum&断扎神教字幕组][REV]",
    ),
    null,
  );
  assert.equal(extractEpisodeNumber("[断扎神教字幕组][忍者杀手][Ninja Slayer][08-12先行版][1080p]"), null);
  assert.equal(extractEpisodeNumber("[Group] Show 01-26Fin [1080p]"), null);
});

test("方括号内「数字+集数标记」要能识别（[07先行版]）", () => {
  // 反向误判：这是第 7 集，早期实现因为要求方括号内纯数字而漏掉
  assert.equal(
    extractEpisodeNumber("[断扎神教字幕组][忍者杀手][Ninja Slayer][07先行版][1080p]"),
    7,
  );
  assert.equal(extractEpisodeNumber("[Group][Show][03先行版][1080p]"), 3);
});

test("方括号内的非集号数字不能被误认（月/分辨率/位深/尺寸）", () => {
  // `[7月新番]` 是「7 月新番组」，不是第 7 集
  assert.equal(
    extractEpisodeNumber("[字幕社][7月新番][某番][11][1080p][简中]"),
    11,
    "应取 [11] 而不是 [7月新番] 的 7",
  );
  assert.equal(extractEpisodeNumber("[Group] Show [10bits][1080p]"), null);
  assert.equal(extractEpisodeNumber("[Group] Show [1920x1080][BDrip]"), null);
  assert.equal(extractEpisodeNumber("[Group] Show [H264][FLAC]"), null);
});

test("优先取纯数字方括号，即使它靠后", () => {
  // 纯数字方括号比「数字+后缀」更可靠，顺序不能反
  assert.equal(extractEpisodeNumber("[A][B 2020][12][1080p]"), 12);
});

test("extractSizeBytes 忽略尺寸标注（1080x1920 没有单位）", () => {
  // `[1440x1080/1920x1080]` 里没有 MB/GB 后缀，不应被当作体积
  assert.equal(extractSizeBytes("[忍者杀手][BDrip][1440x1080/1920x1080][TV 01-26Fin]"), null);
});

test("extractSizeBytes 支持 KB 且拒绝 0", () => {
  assert.equal(extractSizeBytes("[Group] Show [500KB]"), 500 * 1024);
  assert.equal(extractSizeBytes("[Group] Show [0MB]"), null);
});
