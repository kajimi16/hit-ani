/**
 * 收藏状态映射单测。
 *
 * 为什么值得单独测：`2` 是「看过」、`3` 才是「在看」—— 顺序反直觉。
 * 本仓库就曾把两者写反，导致 241 部「看过」被显示成「在看」。
 * 这组断言把 BGM 官方 spec 的映射钉死，防止再次漂移。
 *
 * 依据：`.bgm-v0.yaml` 的 `SubjectCollectionType` 描述与 `x-ms-enum` 值序
 * (`Wish, Done, Doing, OnHold, Dropped`)。
 *
 * 运行：`npm test`
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COLLECTION_STATUSES,
  CollectionStatus,
  statusBySlug,
  statusLabel,
  statusMeta,
} from "@/lib/collection";
import { CollectionType } from "@/lib/bgm/client";

test("CollectionType 数值对齐 BGM 官方 enum（2=看过，3=在看）", () => {
  assert.equal(CollectionType.Wish, 1);
  assert.equal(CollectionType.Done, 2, "2 必须是「看过」");
  assert.equal(CollectionType.Doing, 3, "3 必须是「在看」");
  assert.equal(CollectionType.OnHold, 4);
  assert.equal(CollectionType.Dropped, 5);
});

test("statusLabel 返回正确中文标签", () => {
  assert.equal(statusLabel(1), "想看");
  assert.equal(statusLabel(2), "看过");
  assert.equal(statusLabel(3), "在看");
  assert.equal(statusLabel(4), "搁置");
  assert.equal(statusLabel(5), "抛弃");
});

test("未知状态降级为可读文本而非静默丢失", () => {
  assert.equal(statusLabel(99), "状态 99");
  assert.equal(statusMeta(99), null);
});

test("展示顺序是 想看→在看→看过→搁置→抛弃，与数值顺序不同", () => {
  assert.deepEqual(
    COLLECTION_STATUSES.map((meta) => meta.label),
    ["想看", "在看", "看过", "搁置", "抛弃"],
  );
  // 数值顺序是 1,3,2,4,5 —— 若有人按数值排序会破坏界面顺序
  const values = COLLECTION_STATUSES.map((meta) => meta.value);
  assert.deepEqual(values, [1, 3, 2, 4, 5]);
  assert.notDeepEqual(values, [...values].sort((a, b) => a - b));
});

test("五个状态齐全且 slug 唯一", () => {
  assert.equal(COLLECTION_STATUSES.length, 5);
  assert.equal(new Set(COLLECTION_STATUSES.map((m) => m.slug)).size, 5);
  assert.equal(new Set(COLLECTION_STATUSES.map((m) => m.value)).size, 5);
});

test("slug 反查可用于 ?status= 过滤", () => {
  assert.equal(statusBySlug("doing")?.value, CollectionStatus.Doing);
  assert.equal(statusBySlug("done")?.value, CollectionStatus.Done);
  assert.equal(statusBySlug("on-hold")?.value, CollectionStatus.OnHold);
  assert.equal(statusBySlug("dropped")?.value, CollectionStatus.Dropped);
  assert.equal(statusBySlug("nonsense"), null);
  assert.equal(statusBySlug(undefined), null);
});

test("每个状态都有空状态提示文案", () => {
  for (const meta of COLLECTION_STATUSES) {
    assert.ok(meta.emptyHint.length > 0, `${meta.label} 缺少 emptyHint`);
  }
});
