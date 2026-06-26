/**
 * Canonical per-session chat activity state machine
 * (chat redesign epic #6389, Phase 0 #6390).
 *
 * Answers "what is THIS session's chat doing right now?" — the input the
 * presence rail and composer state-lozenge both read. Previously this
 * lived only in the mobile app (`packages/app/src/store/session-activity.ts`);
 * the dashboard had no equivalent and leaned on a binary `isBusy`. Moving
 * it here makes it the single source both clients map the same way.
 *
 * NOT to be confused with `deriveSessionStatus` in `activity-selectors.ts`:
 * that is the Control Room CROSS-session attention rollup
 * (`running | blocked | failed | idle`) computed from `ActivityEntry[]` — a
 * different abstraction with a different consumer (#5159 / #6182). The
 * names `ActivityState` / `SessionActivityState` are already taken by that
 * Control Room reducer, so the chat machine uses the `Chat*` prefix.
 *
 * Pure, no DOM / React Native deps. Behaviour is identical to the former
 * mobile implementation (state precedence + `startedAt` continuity) so the
 * mobile re-export shim is a drop-in.
 */

/** A session's chat activity at a glance. `busy` is non-streaming work
 *  (e.g. a tool running between streamed text); the spec's finer
 *  `streaming` vs `tool-running` split lands when the rail consumes it and
 *  the extra in-flight-tool input is plumbed through. */
export type ChatActivityState = 'idle' | 'thinking' | 'busy' | 'waiting' | 'error'

export interface SessionChatActivity {
  state: ChatActivityState
  detail?: string
  /** Epoch ms the session entered `state`; preserved across re-derives
   *  while the state is unchanged so consumers can show "for 12s". */
  startedAt: number
}

export interface ChatActivityInput {
  isIdle: boolean
  streamingMessageId: string | null
  isPlanPending: boolean
  pendingPermission?: boolean
  hasError?: boolean
}

/**
 * Derive the chat activity from a session's flags. Precedence (highest
 * first): error → waiting (permission/plan) → thinking (streaming) → busy
 * (not idle) → idle. `startedAt` carries over from `previous` while the
 * state is unchanged, and resets to now on a transition.
 */
export function deriveChatActivity(
  input: ChatActivityInput,
  previous?: SessionChatActivity,
): SessionChatActivity {
  let state: ChatActivityState = 'idle'

  if (input.hasError) {
    state = 'error'
  } else if (input.pendingPermission || input.isPlanPending) {
    state = 'waiting'
  } else if (input.streamingMessageId) {
    state = 'thinking'
  } else if (!input.isIdle) {
    state = 'busy'
  }

  const startedAt = previous && previous.state === state ? previous.startedAt : Date.now()

  return { state, startedAt }
}
