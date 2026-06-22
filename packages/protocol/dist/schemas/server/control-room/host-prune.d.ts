/**
 * Host prune guardrails (#6140): read-only survey of reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure, plus the scoped prune action ack (removes only surveyed ids).
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */
import { z } from 'zod';
/** One prunable chroxy container (stopped/created/dead, not tracked by a live env). */
export declare const HostPruneContainerSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    state: z.ZodString;
    sizeBytes: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
/** One prunable chroxy snapshot image (not referenced by a live env). */
export declare const HostPruneImageSchema: z.ZodObject<{
    id: z.ZodString;
    ref: z.ZodString;
    repository: z.ZodString;
    sizeBytes: z.ZodNullable<z.ZodNumber>;
}, z.core.$strip>;
export declare const ServerHostPruneStatusSnapshotSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_status_snapshot">;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    generatedAt: z.ZodString;
    dockerAvailable: z.ZodBoolean;
    note: z.ZodNullable<z.ZodString>;
    containers: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        state: z.ZodString;
        sizeBytes: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    images: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        ref: z.ZodString;
        repository: z.ZodString;
        sizeBytes: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strip>>;
    summary: z.ZodObject<{
        containerCount: z.ZodNumber;
        imageCount: z.ZodNumber;
        reclaimableBytes: z.ZodNumber;
    }, z.core.$strip>;
    error: z.ZodOptional<z.ZodObject<{
        code: z.ZodString;
        message: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * #6140 — ack for a successful `host_prune_action`. Echoes `kind` (+ optional
 * `requestId`) and carries what was actually removed: per-resource removed counts,
 * an estimated `reclaimedBytes`, and a `failures` list (resources that survived
 * the re-survey but whose `docker rm`/`rmi` failed — e.g. an image still
 * referenced). A failure to even start replies with a `HOST_PRUNE_ACTION_FAILED`
 * session_error carrying the same correlation fields.
 */
export declare const ServerHostPruneActionAckSchema: z.ZodObject<{
    type: z.ZodLiteral<"host_prune_action_ack">;
    kind: z.ZodString;
    requestId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dockerAvailable: z.ZodBoolean;
    removedContainers: z.ZodNumber;
    removedImages: z.ZodNumber;
    reclaimedBytes: z.ZodNumber;
    failures: z.ZodArray<z.ZodObject<{
        ref: z.ZodString;
        error: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$loose>;
