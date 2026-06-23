/**
 * BYOK warm-container pool observability survey (#6135): docker-byok pool limits, live rolling stats, warm buckets, and recent evictions. OFF by default is a first-class state.
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/** Configured pool bounds. `maxAgeMs` is null when unbounded (Infinity). */
export declare const ByokPoolLimitsSchema: z.ZodObject<{
    idleTimeoutMs: z.ZodNumber;
    maxPerKey: z.ZodNumber;
    maxTotal: z.ZodNumber;
    maxAgeMs: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/** One per-resource-shape warm bucket: count + idle age of the oldest entry. */
export declare const ByokPoolBucketSchema: z.ZodObject<{
    key: z.ZodString;
    size: z.ZodNumber;
    oldestIdleMs: z.ZodNumber;
}, z.core.$strip>;
/** One recent eviction (bounded tail): which key/container and why. */
export declare const ByokPoolEvictionSchema: z.ZodObject<{
    key: z.ZodString;
    containerId: z.ZodNullable<z.ZodString>;
    reason: z.ZodString;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
/** Live rolling pool stats from the aggregator. Null when the pool is off. */
export declare const ByokPoolStatsSchema: z.ZodObject<{
    hits: z.ZodNumber;
    misses: z.ZodNumber;
    releases: z.ZodNumber;
    shutdowns: z.ZodNumber;
    hitRate: z.ZodNumber;
    totalSize: z.ZodNumber;
    buckets: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        size: z.ZodNumber;
        oldestIdleMs: z.ZodNumber;
    }, z.core.$strip>>;
    evictionsByReason: z.ZodRecord<z.ZodString, z.ZodNumber>;
    recentEvictions: z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        containerId: z.ZodNullable<z.ZodString>;
        reason: z.ZodString;
        timestamp: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const ServerByokPoolStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"byok_pool_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    enabled: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    limits: z.ZodNullable<z.ZodObject<{
        idleTimeoutMs: z.ZodNumber;
        maxPerKey: z.ZodNumber;
        maxTotal: z.ZodNumber;
        maxAgeMs: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    stats: z.ZodNullable<z.ZodObject<{
        hits: z.ZodNumber;
        misses: z.ZodNumber;
        releases: z.ZodNumber;
        shutdowns: z.ZodNumber;
        hitRate: z.ZodNumber;
        totalSize: z.ZodNumber;
        buckets: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            size: z.ZodNumber;
            oldestIdleMs: z.ZodNumber;
        }, z.core.$strip>>;
        evictionsByReason: z.ZodRecord<z.ZodString, z.ZodNumber>;
        recentEvictions: z.ZodArray<z.ZodObject<{
            key: z.ZodString;
            containerId: z.ZodNullable<z.ZodString>;
            reason: z.ZodString;
            timestamp: z.ZodNumber;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
