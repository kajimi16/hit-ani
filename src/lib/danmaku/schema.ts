import { z } from "zod";
import { DANMAKU_LIMITS, DanmakuLocation } from "./types";

/**
 * 请求体校验。查询串里的数字来自 `URLSearchParams`，一律走 coerce。
 */

export const danmakuQuerySchema = z.object({
  episodeId: z.coerce.number().int().positive(),
  fromMs: z.coerce.number().int().min(0).optional(),
  toMs: z.coerce.number().int().min(0).optional(),
  schoolOnly: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true" || value === "1")),
  limit: z.coerce.number().int().min(1).max(DANMAKU_LIMITS.maxLimit).optional(),
});

export const danmakuSendSchema = z.object({
  episodeId: z.number().int().positive(),
  playTimeMs: z.number().int().min(0),
  text: z.string().min(1).max(DANMAKU_LIMITS.maxTextLength),
  color: z
    .number()
    .int()
    .min(0)
    .max(0xffffff)
    .optional(),
  location: z
    .union([
      z.literal(DanmakuLocation.Normal),
      z.literal(DanmakuLocation.Top),
      z.literal(DanmakuLocation.Bottom),
    ])
    .optional(),
});

export type DanmakuQueryInput = z.input<typeof danmakuQuerySchema>;
export type DanmakuSendInputParsed = z.output<typeof danmakuSendSchema>;
