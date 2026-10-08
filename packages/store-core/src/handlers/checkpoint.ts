/**
 * Shared stateless handlers for checkpoint messages (checkpoint_created /
 * checkpoint_list / checkpoint_restored).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. See
 * ./index.ts for the stateless-handler contract.
 */

import type { ChatMessage, Checkpoint } from '../types'
import { nextMessageId } from '../utils'
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

/** #6767: which parts a checkpoint restore reverted. */
export type RestoreMode = 'files' | 'conversation' | 'both'

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
  /**
   * #6767: the selective-restore mode the server ran. 'conversation'/'both'
   * create + re-home to a new session (so this payload carries a newSessionId);
   * 'files' keeps the current session and omits newSessionId, so this handler
   * returns null for it (no switch) and `mode` is only ever present here for the
   * session-creating modes. Absent when talking to a pre-#6767 server.
   */
  mode?: RestoreMode
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
  // #6767: echo the restore mode when the server supplied a valid one (a 'files'
  // restore never reaches here — it carries no newSessionId and returns null above).
  const mode =
    msg.mode === 'files' || msg.mode === 'conversation' || msg.mode === 'both'
      ? (msg.mode as RestoreMode)
      : undefined
  return { newSessionId: trimmed, filesOnly, ...(mode ? { mode } : {}) }
}

// ---------------------------------------------------------------------------
// checkpoint_restored — 'files'-mode confirmation (#6767 / #6827)
// ---------------------------------------------------------------------------

/**
 * Build the transcript confirmation for a 'files'-mode `checkpoint_restored`.
 *
 * #6827: a files-only restore keeps the current session — the payload carries
 * no `newSessionId`, so {@link handleCheckpointRestored} returns null and
 * nothing re-homes. Without this the revert would be invisible client-side.
 * Returns a `system` ChatMessage for the active session's transcript (the
 * `budget_resumed` pattern — rendered identically by both clients), naming the
 * checkpoint when the server supplied `name` (the CHECKPOINT's name here; in
 * the session-creating modes `name` is the new session's name instead).
 * Returns null for any non-'files' payload — the re-home path owns those.
 */
export function handleCheckpointFilesRestored(
  msg: Record<string, unknown>,
): { systemMessage: ChatMessage } | null {
  if (msg.mode !== 'files') return null
  const name = typeof msg.name === 'string' && msg.name.trim().length > 0 ? msg.name.trim() : null
  return {
    systemMessage: {
      id: nextMessageId('system'),
      type: 'system',
      content: name ? `Files restored to checkpoint "${name}"` : 'Files restored to checkpoint',
      timestamp: Date.now(),
    },
  }
}

// ---------------------------------------------------------------------------
// checkpoint_restored — session-creating confirmation (#6808)
// ---------------------------------------------------------------------------

/**
 * Look up a checkpoint's display name by id in a local checkpoint list.
 *
 * For the session-creating modes the wire `name` is the NEW session's name
 * ("Rewind: <checkpoint>"), not the checkpoint's, so the notice resolves the
 * checkpoint name from the client's own list instead of parsing that string.
 * Returns null when the id is unknown or the name blank, so callers fall back to
 * generic wording rather than naming the wrong thing.
 */
export function findCheckpointName(
  checkpoints: readonly Checkpoint[],
  checkpointId: unknown,
): string | null {
  if (typeof checkpointId !== 'string') return null
  const cp = checkpoints.find((c) => c.id === checkpointId)
  const name = typeof cp?.name === 'string' ? cp.name.trim() : ''
  return name.length > 0 ? name : null
}

/**
 * Build the `system` transcript notice for a session-creating `checkpoint_restored`
 * ('conversation' / 'both' / a pre-#6767 payload with no mode), saying truthfully
 * what the restore did (#6808).
 *
 * `filesOnly` is the server's report of whether the conversation was branched:
 * `false` means it was forked and truncated to the checkpoint; `true` (also the
 * parsed default for a legacy server) means it was NOT, so the new session simply
 * resumes the full conversation. The wording never claims a rewind that did not
 * happen. A missing `mode` is a pre-#6767 server, which always reverted the files
 * as well, so it reads as 'both'. The 'files' mode keeps its own wording in
 * {@link handleCheckpointFilesRestored} (it never reaches here: no `newSessionId`).
 */
export function buildCheckpointRestoreNotice(
  restored: Pick<CheckpointRestoredPayload, 'filesOnly' | 'mode'>,
  checkpointName?: string | null,
): ChatMessage {
  const name = typeof checkpointName === 'string' ? checkpointName.trim() : ''
  const cp = name.length > 0 ? `checkpoint "${name}"` : 'the checkpoint'
  const mode: RestoreMode = restored.mode ?? 'both'
  let content: string
  if (mode === 'conversation') {
    content = restored.filesOnly
      ? `Opened a new session at ${cp}, but the conversation was not rewound and files were not changed.`
      : `Conversation branched from ${cp} into this new session. Files were not changed.`
  } else {
    content = restored.filesOnly
      ? `Files restored to ${cp}. This provider can't branch the conversation, so this new session continues the full conversation (not rewound).`
      : `Rewound to ${cp}: files restored and the conversation branched into this new session`
  }
  return { id: nextMessageId('system'), type: 'system', content, timestamp: Date.now() }
}

/**
 * Whether a restore in `mode` can branch the conversation, given whether the
 * active session's provider can fork a resumed transcript (#6808).
 *
 * The pre-restore picker copy uses this so it only promises a branch the server
 * can deliver: 'files' never branches; 'both' and 'conversation' branch only on a
 * fork-capable provider. ('both' on any other provider still opens a new session,
 * but it resumes the full conversation, and the post-restore notice says so.) A
 * fork-capable provider can still fall back to files-only at restore time (a
 * checkpoint with no recorded branch point), which is why the notice, not this
 * prediction, is the authority on what happened.
 */
export function restoreCanBranchConversation(mode: RestoreMode, providerCanFork: boolean): boolean {
  return mode !== 'files' && providerCanFork
}

// The notice must land AFTER the new session's history replay. The restore
// switches to a session this client has no transcript for; the switch asks the
// server to replay it, and a full-history replay drops everything that was in the
// transcript before `history_replay_start` (reconcileReplayEnd). So a notice
// appended at `checkpoint_restored` time is wiped moments later. It is parked here,
// keyed by the new session id, and the clients append it right after that
// session's `history_replay_end` swap. Module state, like the replay window it
// pairs with; bounded by a TTL so one that never meets a replay (socket dropped
// mid-switch) cannot surface on a much later one.
const PENDING_RESTORE_NOTICE_TTL_MS = 60_000
const pendingRestoreNotices = new Map<string, { message: ChatMessage; at: number }>()

/** Park a restore notice for `sessionId` until its history replay ends (#6808). */
export function stashPendingRestoreNotice(
  sessionId: string,
  message: ChatMessage,
  now: number = Date.now(),
): void {
  pendingRestoreNotices.set(sessionId, { message, at: now })
}

/**
 * Take (and clear) the parked restore notice for `sessionId`, or null when there
 * is none or it has expired (#6808). Call after the session's replay-end swap.
 */
export function takePendingRestoreNotice(
  sessionId: string | null | undefined,
  now: number = Date.now(),
): ChatMessage | null {
  if (!sessionId) return null
  const entry = pendingRestoreNotices.get(sessionId)
  if (!entry) return null
  pendingRestoreNotices.delete(sessionId)
  return now - entry.at <= PENDING_RESTORE_NOTICE_TTL_MS ? entry.message : null
}

/** Drop every parked restore notice (test isolation, and a full store reset). */
export function clearPendingRestoreNotices(): void {
  pendingRestoreNotices.clear()
}
