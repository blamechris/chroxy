/**
 * The ONE builder of the wire `thinking_level_changed` frame (#8700).
 *
 * Four senders put this frame on the wire: ws-history's `sendSessionInfo`
 * replay (reconnect / tab switch), the event normalizer's `ready` burst, the
 * `set_thinking_level` handler after an accepted change, and the normalizer's
 * own `thinking_level_changed` entry for a level the SESSION changed or learned
 * (a model switch that dropped an unoffered level, the effort Claude Code
 * reported at the start of a turn). Each used to spell `{ level }` by hand, so a
 * field added to one sender was missing from the rest — a replay would then
 * erase what the live frame had said. They all build it here instead.
 *
 * `level` is what the operator asked for (`default` when nothing was asked).
 * `effective` is what the provider REPORTS it applied, and it is sent only by a
 * provider that declares `capabilities.thinkingLevelEffective`: there `null`
 * means "not reported yet", while an absent key (every other provider) means
 * "this provider makes no such report". Clients render the two differently, so
 * the builder never collapses one into the other.
 *
 * Returns null for a session with no thinking-level concept (`thinkingLevel`
 * getter `undefined`, BaseSession's default), so no sender invents a `default`
 * that would stomp a client's state for a provider that never had one.
 */
import { LEGACY_DEFAULT_THINKING_LEVEL } from '@chroxy/protocol'

/**
 * @param {object|null|undefined} session
 * @returns {{ type: 'thinking_level_changed', level: string, effective?: string|null } | null}
 */
export function buildThinkingLevelChanged(session) {
  const level = session?.thinkingLevel
  if (level === undefined) return null
  const msg = { type: 'thinking_level_changed', level: level || LEGACY_DEFAULT_THINKING_LEVEL }
  if (session.constructor?.capabilities?.thinkingLevelEffective === true) {
    const effective = session.effectiveThinkingLevel
    msg.effective = typeof effective === 'string' && effective.length > 0 ? effective : null
  }
  return msg
}
