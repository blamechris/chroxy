/**
 * Shared stateless handlers for checkpoint messages (checkpoint_created /
 * checkpoint_list / checkpoint_restored).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. See
 * ./index.ts for the stateless-handler contract.
 */

import type { Checkpoint } from '../types'
import { resolveSessionId } from './_shared'

// ---------------------------------------------------------------------------
// checkpoint_created
// ---------------------------------------------------------------------------

/**
 * Append a newly created checkpoint to the active-session checkpoint list.
 *
 * Both clients gate on `msg.sessionId === activeSessionId` (with the usual
 * "fall back to active when sessionId is absent" rule) and ignore malformed
 * payloads. This handler encodes that gate: returns the new list when the
 * append should happen, or null when the message should be ignored.
 *
 * Per-element shape is NOT validated — the cast to `Checkpoint` matches the
 * inline behaviour in both clients prior to this migration. Tightening would
 * be a behaviour change beyond the scope of #2661.
 */
export function handleCheckpointCreated(
  msg: Record<string, unknown>,
  currentCheckpoints: Checkpoint[],
  activeSessionId: string | null,
): Checkpoint[] | null {
  const targetId = resolveSessionId(msg, activeSessionId)
  if (!targetId || targetId !== activeSessionId) return null
  const cp = msg.checkpoint
  if (!cp || typeof cp !== 'object') return null
  return [...currentCheckpoints, cp as Checkpoint]
}

// ---------------------------------------------------------------------------
// checkpoint_list
// ---------------------------------------------------------------------------

/**
 * Replace the active-session checkpoint list with the server-provided array.
 *
 * Same active-session gate as `handleCheckpointCreated`. Returns the new array
 * (which may be empty) when the replace should happen, or null when the
 * message should be ignored (different session, missing/non-array payload,
 * or no active session to fall back to).
 */
export function handleCheckpointList(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): Checkpoint[] | null {
  const targetId = resolveSessionId(msg, activeSessionId)
  if (!targetId || targetId !== activeSessionId) return null
  if (!Array.isArray(msg.checkpoints)) return null
  return msg.checkpoints as Checkpoint[]
}

// ---------------------------------------------------------------------------
// checkpoint_restored
// ---------------------------------------------------------------------------

/** Parsed payload from a `checkpoint_restored` message. */
export interface CheckpointRestoredPayload {
  newSessionId: string
  /**
   * #6766: true when the restore reverted only the working tree and did NOT
   * branch the conversation (the provider can't fork/truncate a resumed
   * transcript); false when the conversation was forked/truncated to the
   * checkpoint. Defaults to true when the server omits the field (older servers
   * never branched), so callers never over-claim a conversation rewind.
   */
  filesOnly: boolean
}

/**
 * Extract the new session ID (and the files-only flag) from a
 * `checkpoint_restored` message.
 *
 * App-only handler today (the dashboard's `checkpoint_restored` is a no-op);
 * extracted here so dashboard can adopt the same handler later if/when it
 * grows that surface. Returns null when the payload is missing, malformed,
 * or empty after trimming — matching the inline guard `if (restoredNewSid.length > 0)`.
 *
 * Restore-flow side effects (e.g. `switchSession`) stay platform-specific and
 * are gated by the caller on a non-null return.
 */
export function handleCheckpointRestored(
  msg: Record<string, unknown>,
): CheckpointRestoredPayload | null {
  const raw = msg.newSessionId
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // #6766: default to files-only unless the server explicitly says otherwise, so
  // a missing/legacy flag never lets a client claim a conversation rewind.
  const filesOnly = typeof msg.filesOnly === 'boolean' ? msg.filesOnly : true
  return { newSessionId: trimmed, filesOnly }
}
