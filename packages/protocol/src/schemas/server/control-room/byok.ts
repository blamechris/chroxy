/**
 * BYOK warm-container pool observability survey (#6135): docker-byok pool limits, live rolling stats, warm buckets, and recent evictions. OFF by default is a first-class state.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// #6135 (epic #5530) — Control Room "BYOK pool" tab: docker-byok warm-container
// pool observability. Emitted in reply to a `byok_pool_status_request` (see
// client.ts). Read-only. The pool is OFF by default — `enabled: false` with a
// `note` is a first-class state, not an error. Same pull-on-Refresh,
// degraded-snapshot-with-`error` posture as the sibling surveys.
// ---------------------------------------------------------------------------

/** Configured pool bounds. `maxAgeMs` is null when unbounded (Infinity). */
export const ByokPoolLimitsSchema = z.object({
  idleTimeoutMs: z.number().nonnegative().finite(),
  maxPerKey: z.number().int().nonnegative().finite(),
  maxTotal: z.number().int().nonnegative().finite(),
  maxAgeMs: z.number().nonnegative().finite().nullable(),
})

/** One per-resource-shape warm bucket: count + idle age of the oldest entry. */
export const ByokPoolBucketSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative().finite(),
  oldestIdleMs: z.number().nonnegative().finite(),
})

/** One recent eviction (bounded tail): which key/container and why. */
export const ByokPoolEvictionSchema = z.object({
  key: z.string(),
  containerId: z.string().nullable(),
  reason: z.string(),
  timestamp: z.number().finite(),
})

/** Live rolling pool stats from the aggregator. Null when the pool is off. */
export const ByokPoolStatsSchema = z.object({
  hits: z.number().int().nonnegative().finite(),
  misses: z.number().int().nonnegative().finite(),
  releases: z.number().int().nonnegative().finite(),
  shutdowns: z.number().int().nonnegative().finite(),
  hitRate: z.number().finite(),
  totalSize: z.number().int().nonnegative().finite(),
  buckets: z.array(ByokPoolBucketSchema),
  // Per-reason eviction counts — non-negative integers, matching the other count
  // fields' rigor (the aggregator only ever produces integer counts).
  evictionsByReason: z.record(z.string(), z.number().int().nonnegative().finite()),
  recentEvictions: z.array(ByokPoolEvictionSchema),
})

export const ServerByokPoolStatusSnapshotSchema = z.object({
  type: z.literal('byok_pool_status_snapshot'),
  // Echoes the client's request requestId (null when omitted) for correlation.
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // Whether the docker-byok pool is enabled on this host. When false, `limits`
  // and `stats` are null and `note` explains why — a first-class state.
  enabled: z.boolean(),
  note: z.string().nullable(),
  limits: ByokPoolLimitsSchema.nullable(),
  stats: ByokPoolStatsSchema.nullable(),
  // Additive degraded-snapshot annotation (mirrors the sibling surveys): a
  // forbidden/in-progress/failed survey returns an otherwise-valid (disabled,
  // null limits/stats) snapshot plus this `error`.
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
})
