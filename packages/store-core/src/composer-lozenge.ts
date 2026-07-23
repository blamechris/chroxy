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

import type { ChatActivityState } from './chat-activity'

/** Fixed glyph for every active state — a generic "the machine is doing
 *  something" marker, not a per-state icon. Keeps the badge visually calm;
 *  the label text (and the hairline's color) carry the state distinction. */
const LOZENGE_GLYPH = '◐'

/**
 * Display label per `ChatActivityState`. `thinking` reads "streaming"
 * because `deriveChatActivity` sets that state precisely while
 * `streamingMessageId` is set — i.e. while tokens are actively flowing (see
 * `chat-activity.ts`'s doc comment: "busy is non-streaming work").
 *
 * Typed as `Record<ChatActivityState, string>` (not `Record<string, string>`)
 * so this map is keyed to the real state union: an unrecognized/typo'd key
 * is a compile error here, and adding a new `ChatActivityState` without
 * updating this map is *also* a compile error (missing property), rather
 * than the old `Record<string, string>` silently accepting anything and
 * making every lookup look always-defined.
 *
 * `idle` maps to the empty string (not omitted — a full `Record` requires
 * every key) so the lozenge still hides for it: the `if (!label) return
 * null` check below treats `''` the same as "no label", keeping a single
 * fallback path for "hidden" rather than special-casing idle.
 */
const STATE_LABEL: Record<ChatActivityState, string> = {
  idle: '',
  thinking: 'streaming',
  busy: 'busy',
  waiting: 'waiting',
  error: 'error',
}

/**
 * Format the composer lozenge text for a given chat-activity state and
 * queued-follow-up count, or `null` when the lozenge should not render at
 * all (idle, or an undefined state — fail closed rather than show a
 * guessed label).
 *
 *   formatComposerLozenge('thinking', 2) → '◐ streaming · +2 queued'
 *   formatComposerLozenge('thinking', 0) → '◐ streaming'
 *   formatComposerLozenge('busy', 1)     → '◐ busy · +1 queued'
 *   formatComposerLozenge('idle', 3)     → null (hidden even with a queue —
 *                                           an idle turn has nothing "alive"
 *                                           to report; #6906 flushes queued
 *                                           messages as soon as idle anyway)
 *
 * `state` is typed `ChatActivityState | undefined` (not `string`) so a
 * typo'd/unknown state is a compile error at call sites, not a silent
 * runtime `null` — the `if (!label) return null` below is a *defensive*
 * runtime fallback (idle's empty-string label, or a value that reaches
 * here from outside TS's view, e.g. a non-TS caller), not the type
 * contract.
 *
 * `queuedCount` is defensively floored at 0 and truncated to an integer, so
 * a stale/negative/non-finite count from an in-flight store update can't
 * render nonsense like "+-1 queued" or "+2.5 queued".
 */
export function formatComposerLozenge(
  state: ChatActivityState | undefined,
  queuedCount: number,
): string | null {
  if (!state) return null
  const label = STATE_LABEL[state]
  if (!label) return null

  const n = Number.isFinite(queuedCount) ? Math.max(0, Math.trunc(queuedCount)) : 0
  return n > 0 ? `${LOZENGE_GLYPH} ${label} · +${n} queued` : `${LOZENGE_GLYPH} ${label}`
}
