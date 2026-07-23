/**
 * Composer state lozenge (chat redesign epic #6389/#6391, Phase 1 — deferred
 * item now approved).
 *
 * A small text badge on the composer's top-left edge — "◐ streaming ·
 * +2 queued" — that names the canonical chat-activity state (from
 * `deriveChatActivity` / `ChatActivityState`) alongside the queue-while-
 * processing follow-up count. It sits on the SAME `data-activity-state` /
 * `activityState` value that already drives the composer's live hairline
 * (dashboard `InputBar.tsx` `.input-bar[data-activity-state]`, mobile
 * `InputBar.tsx` `HAIRLINE_COLOR`) — the hairline supplies the color, the
 * lozenge supplies the label, so the two read as one signal instead of two
 * competing cues.
 *
 * Pure, no DOM / React Native deps — both clients import this one formatter
 * so the composer copy can't drift between the dashboard and mobile twin.
 */

/** Fixed glyph for every active state — a generic "the machine is doing
 *  something" marker, not a per-state icon. Keeps the badge visually calm;
 *  the label text (and the hairline's color) carry the state distinction. */
const LOZENGE_GLYPH = '◐'

/**
 * Display label per non-idle `ChatActivityState`. `thinking` reads
 * "streaming" because `deriveChatActivity` sets that state precisely while
 * `streamingMessageId` is set — i.e. while tokens are actively flowing (see
 * `chat-activity.ts`'s doc comment: "busy is non-streaming work"). Any state
 * absent from this map (currently only `idle`, plus defensively any future/
 * unrecognized value) hides the lozenge rather than guessing a label.
 */
const STATE_LABEL: Record<string, string> = {
  thinking: 'streaming',
  busy: 'busy',
  waiting: 'waiting',
  error: 'error',
}

/**
 * Format the composer lozenge text for a given chat-activity state and
 * queued-follow-up count, or `null` when the lozenge should not render at
 * all (idle, or any state this module doesn't recognize — fail closed
 * rather than show a guessed label).
 *
 *   formatComposerLozenge('thinking', 2) → '◐ streaming · +2 queued'
 *   formatComposerLozenge('thinking', 0) → '◐ streaming'
 *   formatComposerLozenge('busy', 1)     → '◐ busy · +1 queued'
 *   formatComposerLozenge('idle', 3)     → null (hidden even with a queue —
 *                                           an idle turn has nothing "alive"
 *                                           to report; #6906 flushes queued
 *                                           messages as soon as idle anyway)
 *
 * `queuedCount` is defensively floored at 0 and truncated to an integer, so
 * a stale/negative/non-finite count from an in-flight store update can't
 * render nonsense like "+-1 queued" or "+2.5 queued".
 */
export function formatComposerLozenge(
  state: string | undefined,
  queuedCount: number,
): string | null {
  if (!state) return null
  const label = STATE_LABEL[state]
  if (!label) return null

  const n = Number.isFinite(queuedCount) ? Math.max(0, Math.trunc(queuedCount)) : 0
  return n > 0 ? `${LOZENGE_GLYPH} ${label} · +${n} queued` : `${LOZENGE_GLYPH} ${label}`
}
