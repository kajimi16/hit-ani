/**
 * Bangumi 收藏状态的唯一权威映射。
 *
 * ⚠️ 这组数字极易搞错（本仓库就错过一次，把「在看」和「看过」写反了）。
 * 依据是 `.bgm-v0.yaml` 中 `SubjectCollectionType` 的官方描述：
 *
 * ```
 * - `1`: 想看
 * - `2`: 看过
 * - `3`: 在看
 * - `4`: 搁置
 * - `5`: 抛弃
 * x-ms-enum: { values: [Wish, Done, Doing, OnHold, Dropped] }
 * ```
 *
 * **注意 2 与 3 的顺序反直觉**：2 是「看过」，3 才是「在看」。
 * 这与旧版 Bangumi API 的 `wish/collect/doing/on_hold/dropped` 命名一致。
 *
 * 展示顺序单独定义（DISPLAY_ORDER），不依赖数值大小 —— 数值顺序是 2 在 3 前面，
 * 但界面上「在看」应排在「看过」之前。
 */

/** 收藏状态数值，对齐 BGM `SubjectCollectionType`。 */
export const CollectionStatus = {
  Wish: 1,
  Done: 2,
  Doing: 3,
  OnHold: 4,
  Dropped: 5,
} as const;

export type CollectionStatusValue =
  (typeof CollectionStatus)[keyof typeof CollectionStatus];

export interface CollectionStatusMeta {
  value: CollectionStatusValue;
  /** 中文标签 */
  label: string;
  /** 英文 key，用于 URL 参数 */
  slug: string;
  /** 空状态提示文案 */
  emptyHint: string;
}

/**
 * 五种状态，按**界面展示顺序**排列：
 * 想看 → 在看 → 看过 → 搁置 → 抛弃（与 Bangumi 站内一致）。
 */
export const COLLECTION_STATUSES: readonly CollectionStatusMeta[] = [
  {
    value: CollectionStatus.Wish,
    label: "想看",
    slug: "wish",
    emptyHint: "还没有想看的番。在条目页点「想看」即可加入这里。",
  },
  {
    value: CollectionStatus.Doing,
    label: "在看",
    slug: "doing",
    emptyHint: "当前没有在追的番。",
  },
  {
    value: CollectionStatus.Done,
    label: "看过",
    slug: "done",
    emptyHint: "还没有看完的番。",
  },
  {
    value: CollectionStatus.OnHold,
    label: "搁置",
    slug: "on-hold",
    emptyHint: "没有搁置的番。",
  },
  {
    value: CollectionStatus.Dropped,
    label: "抛弃",
    slug: "dropped",
    emptyHint: "没有抛弃的番。",
  },
] as const;

const BY_VALUE = new Map<number, CollectionStatusMeta>(
  COLLECTION_STATUSES.map((meta) => [meta.value, meta]),
);

const BY_SLUG = new Map<string, CollectionStatusMeta>(
  COLLECTION_STATUSES.map((meta) => [meta.slug, meta]),
);

/** 数值 → 元数据。未知数值返回 null（上游新增状态时不至于崩）。 */
export function statusMeta(value: number): CollectionStatusMeta | null {
  return BY_VALUE.get(value) ?? null;
}

/** 数值 → 中文标签。未知数值降级为 `状态 N`，保留信息而非静默丢失。 */
export function statusLabel(value: number): string {
  return BY_VALUE.get(value)?.label ?? `状态 ${value}`;
}

/** URL slug → 元数据，用于 `?status=` 过滤。 */
export function statusBySlug(slug: string | undefined): CollectionStatusMeta | null {
  return slug ? (BY_SLUG.get(slug) ?? null) : null;
}
