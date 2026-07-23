/**
 * edit-queued — shared decision logic for "Edit a still-queued follow-up"
 * (#6628, queue-while-processing).
 *
 * Editing a queued message is cancel-and-reopen: cancel the queued entry (its
 * optimistic drop clears the bubble + badge) and reopen its text in the composer
 * for amend + re-send. The naive version overwrote the composer unconditionally,
 * which SILENTLY DISCARDS an in-progress draft — queue-while-processing is a
 * multi-message flow, so a user mid-typing a SECOND follow-up who clicks Edit on
 * the queued one loses their in-progress draft (the #6628 review blocker).
 *
 * The invariant this helper enforces:
 *   - No in-progress composer draft is ever discarded without the user's
 *     awareness.
 *   - The queued message is never stranded.
 *
 * Branches:
 *   - Non-empty draft → notify + bail. The queued entry is left intact and the
 *     draft is untouched (no silent clobber, nothing stranded).
 *   - cancelQueued() === false (closed socket — fail-closed, entry NOT dropped)
 *     → bail. Composer untouched, queued entry preserved.
 *   - Empty draft (the common case) → cancel the queued entry and reopen its
 *     text; behavior is unchanged from before the guard.
 *
 * The app (`packages/app/src/utils/edit-queued.ts`) carries a parallel copy —
 * keep the two in sync. It is kept local to each client rather than shared via
 * store-core so this PR stays free of protocol/dist rebuild concerns.
 */

export interface EditQueuedEffects {
  /** Current composer draft text (untrimmed). */
  getDraft: () => string
  /**
   * Cancel the queued entry by id. Returns `false` on a closed socket WITHOUT
   * dropping the entry (fail-closed), `true` otherwise.
   */
  cancelQueued: (id: string) => boolean
  /** Reopen `text` in the composer for amend + re-send. */
  reopenComposer: (text: string) => void
  /** Surface a non-blocking notice (the draft-would-be-clobbered guard). */
  notify: (message: string) => void
  /** Optional: focus the composer after reopening. */
  focusComposer?: () => void
}

export const EDIT_QUEUED_BUSY_NOTICE =
  'Finish or clear your current message before editing the queued one.'

/**
 * Decide + apply what editing a still-queued follow-up should do, given the
 * composer's current draft. Pure control flow over injected effects so both
 * clients (and their unit tests) share one implementation.
 */
export function runQueuedEdit(id: string, text: string, fx: EditQueuedEffects): void {
  // Guard: never clobber an in-progress draft. Leave the queued entry intact
  // (do NOT cancel) so nothing is stranded, and tell the user why.
  if (fx.getDraft().trim().length > 0) {
    fx.notify(EDIT_QUEUED_BUSY_NOTICE)
    return
  }
  // Fail-closed: a closed socket returns false without dropping the entry —
  // bail without touching the composer so nothing is clobbered or stranded.
  if (fx.cancelQueued(id) === false) return
  fx.reopenComposer(text)
  fx.focusComposer?.()
}
