/**
 * Host prune guardrails (#6140): read-only survey of reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure, plus the scoped prune action ack (removes only surveyed ids).
 *
 * Per-tab slice of the Control Room schema surface; re-exported verbatim by
 * ../control-room.ts (sub-barrel). Split per #6272 (follow-up to #6271 Tier-3).
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// #6140 (epic #5530) — Control Room host prune guardrails. Read-only survey of
// reclaimable, chroxy-scoped, ORPHAN-ONLY host docker pressure, plus a prune
// action that removes ONLY those surveyed ids (never a blanket docker prune,
// never a running/tracked/non-chroxy resource). Same degraded-snapshot posture
// as the sibling surveys: docker absent → dockerAvailable:false + a note, never
// an error.
// ---------------------------------------------------------------------------

/** One prunable chroxy container (stopped/created/dead, not tracked by a live env). */
export const HostPruneContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  sizeBytes: z.number().nonnegative().finite().nullable(),
})

/** One prunable chroxy snapshot image (not referenced by a live env). */
export const HostPruneImageSchema = z.object({
  id: z.string(),
  ref: z.string(),
  repository: z.string(),
  sizeBytes: z.number().nonnegative().finite().nullable(),
})

export const ServerHostPruneStatusSnapshotSchema = z.object({
  type: z.literal('host_prune_status_snapshot'),
  requestId: z.string().nullable().optional(),
  generatedAt: z.string().datetime(),
  // Whether docker could be probed. false → containers/images empty, note set.
  dockerAvailable: z.boolean(),
  // Additive note (e.g. docker unavailable, or one image repo couldn't be listed).
  note: z.string().nullable(),
  containers: z.array(HostPruneContainerSchema),
  images: z.array(HostPruneImageSchema),
  summary: z.object({
    containerCount: z.number().int().nonnegative().finite(),
    imageCount: z.number().int().nonnegative().finite(),
    // Upper-bound estimate (image layers are shared) — labelled as such in the UI.
    reclaimableBytes: z.number().nonnegative().finite(),
  }),
  // Degraded-snapshot annotation (forbidden/in-progress/failed), like siblings.
  error: z
    .object({ code: z.string(), message: z.string() })
    .optional(),
}).passthrough()

/**
 * #6140 — ack for a successful `host_prune_action`. Echoes `kind` (+ optional
 * `requestId`) and carries what was actually removed: per-resource removed counts,
 * an estimated `reclaimedBytes`, and a `failures` list (resources that survived
 * the re-survey but whose `docker rm`/`rmi` failed — e.g. an image still
 * referenced). A failure to even start replies with a `HOST_PRUNE_ACTION_FAILED`
 * session_error carrying the same correlation fields.
 */
export const ServerHostPruneActionAckSchema = z.object({
  type: z.literal('host_prune_action_ack'),
  kind: z.string(),
  requestId: z.string().max(128).nullable().optional(),
  dockerAvailable: z.boolean(),
  removedContainers: z.number().int().nonnegative().finite(),
  removedImages: z.number().int().nonnegative().finite(),
  reclaimedBytes: z.number().nonnegative().finite(),
  failures: z.array(z.object({ ref: z.string(), error: z.string() })),
}).passthrough()
