/**
 * The transcript marker for a turn that did not complete normally (#7326).
 *
 * A `result` frame can say HOW the turn ended (`turnOutcome`: completed /
 * truncated / refused / stopped -- see `@chroxy/protocol`'s turn-outcome.ts).
 * Before #7326 a reply cut off by a token limit, or a request the model declined,
 * rendered exactly like a finished turn. This module turns the three non-clean
 * outcomes into a `system` ChatMessage that BOTH clients show as a small chip at
 * the end of the turn, so the two cannot drift on when a marker appears, what it
 * says, or where it sits.
 *
 * It is a message of its own, not a flag on the turn's last bubble, for one
 * reason that matters: a refusal very often produces no assistant text at all.
 * A flag would have no bubble to sit on, and the case it exists for would stay
 * invisible.
 *
 * Built from the `result` frame on the same unconditional, live-or-replayed
 * path `markTurnBoundary` uses, and the server records `turnOutcome` in the
 * history entry the replay re-sends as a literal `result`, so a session switch
 * or a reload rebuilds the same marker. APPENDED at the end of the list, never
 * inserted: the replay-provenance observer (`noteReplayMessagesUpdate`) can
 * follow an append but drops its record on an insert. The consequence, accepted
 * and stated: if a send-while-busy follow-up is queued, its `user_input` row
 * already sits at the tail when the result lands, and the marker follows it.
 */
import { describeTurnOutcome, isMarkedTurnOutcome } from '@chroxy/protocol'
import type { MarkedTurnOutcome } from '@chroxy/protocol'
import type { ChatMessage } from './types'
import { nextMessageId } from './utils'

/** Test id both clients put on the chip, so one smoke script drives either. */
export const TURN_OUTCOME_MARKER_TESTID = 'turn-outcome-marker'

/** What a `result` frame says about how its turn ended, when that deserves a marker. */
export interface TurnOutcomeEvent {
  outcome: MarkedTurnOutcome
  /**
   * The frame's own `timestamp` (the server stamps the SAME value on the live
   * frame and on the history entry it replays), or null from an older server.
   * It is the marker's identity: see {@link appendTurnOutcomeMarker}.
   */
  timestamp: number | null
}

/**
 * Read the marked outcome off a `result` frame. `null` for `completed`, for an
 * absent field (older server, or a provider that did not say) and for a value
 * this build cannot word -- none of which gets a marker.
 */
export function readResultTurnOutcome(msg: Record<string, unknown>): TurnOutcomeEvent | null {
  if (!isMarkedTurnOutcome(msg.turnOutcome)) return null
  const ts = msg.timestamp
  return { outcome: msg.turnOutcome, timestamp: typeof ts === 'number' && Number.isFinite(ts) ? ts : null }
}

/**
 * What the chip says. The label alone for every outcome except
 * `stopped_before_output` (#9241), which is the one marker that stands for a turn
 * with no reply at all: it carries the time as well ("Stopped before a
 * reply · 14:05", local time, 24 hour), because with nothing else in the turn it is
 * the only record of when it happened. Both clients render this one string.
 */
export function turnOutcomeMarkerText(outcome: MarkedTurnOutcome, timestamp?: number | null): string | null {
  const description = describeTurnOutcome(outcome)
  if (!description) return null
  if (outcome !== 'stopped_before_output' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return description.label
  }
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return description.label
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${description.label} \u00b7 ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** True for the `system` message {@link appendTurnOutcomeMarker} builds. */
export function isTurnOutcomeMarker(m: ChatMessage): boolean {
  return m.type === 'system' && m.turnOutcome !== undefined
}

/**
 * True when `m` belongs on the System tab (and in its unread badge): a `system`
 * row that is NOT a turn-outcome marker. The chip describes the turn above it, so
 * it lives in the chat flow only (the shared `buildChatViewMessages` pipeline
 * lets it through); listing it a second time on the System tab put the same
 * event on two tabs and bumped a badge for something the user was already
 * looking at. Both clients derive the System tab from this one predicate, so the
 * live append and a replay rebuild cannot disagree about it (#8461).
 */
export function isSystemTabMessage(m: ChatMessage): boolean {
  return m.type === 'system' && !isTurnOutcomeMarker(m)
}

/**
 * Append the marker for `event` to `messages`. Returns `messages` unchanged (same
 * reference) when there is nothing to mark, so a caller can chain it without a
 * needless write.
 *
 * ONE MARKER PER TURN, even when a `result` is delivered twice. A client that
 * watched the turn live and then reconnects is replayed that turn's entries
 * again, and the `message` frames dedup against what it holds -- but a `result`
 * has no id, so without this the replay would add a second chip, at the end of
 * the transcript. The identity is the frame's `timestamp`: the server stamps it
 * once on the result event, so the live frame and the history entry the replay
 * re-sends carry the SAME value. `dedupView` is what to look for a held marker
 * in: pass `replayDedupCache(sessionId, messages)`, which during a full rebuild
 * is the appended tail only, so a marker in the prefix that is about to be
 * discarded does not suppress the one that has to replace it. A frame with no
 * timestamp (an older server, which also sends no outcome) is never deduped.
 *
 * `now` is injectable for tests.
 */
export function appendTurnOutcomeMarker(
  messages: ChatMessage[],
  event: TurnOutcomeEvent | null,
  dedupView: readonly ChatMessage[] = messages,
  now: number = Date.now(),
): ChatMessage[] {
  if (!event) return messages
  const description = describeTurnOutcome(event.outcome)
  if (!description) return messages
  if (
    event.timestamp !== null &&
    dedupView.some(
      (m) => isTurnOutcomeMarker(m) && m.turnOutcome === event.outcome && m.timestamp === event.timestamp,
    )
  ) {
    return messages
  }
  return [
    ...messages,
    {
      id: nextMessageId('outcome'),
      type: 'system',
      content: description.label,
      timestamp: event.timestamp ?? now,
      turnOutcome: event.outcome,
    },
  ]
}
