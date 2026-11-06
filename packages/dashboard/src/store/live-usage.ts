/**
 * Single source of truth for "live `sessionStates[id].cumulativeUsage`
 * overlays the `session_list` snapshot" (#7801).
 *
 * `session_list` replaces the `sessions` snapshot while `session_usage`
 * patches `sessionStates[id].cumulativeUsage`; the two slices update
 * independently and the live one is always at least as fresh (#7793, #4073,
 * #4120). Two consumers need the overlay (App's per-session cost badge and
 * Sidebar's Tokens panel). They previously carried separate copies of the
 * selector and the `live ?? snapshot` rule, and the copy drifted on the one
 * line that is load-bearing: `useShallow` (#7797). Both now go through this
 * module, so the equality wrapper and the fallback semantics live in one place.
 */
import { useShallow } from 'zustand/react/shallow'
import type { CumulativeUsage, SessionInfo } from '@chroxy/store-core'
import { useConnectionStore } from './connection'
import type { ConnectionState } from './types'

export type LiveUsageMap = Record<string, CumulativeUsage | null | undefined>

/**
 * Project `sessionStates` down to `{ [id]: cumulativeUsage }`.
 *
 * Allocates a fresh record per call, so it MUST be consumed through
 * `useShallow` (see `useLiveCumulativeUsage`). For-in + index lookup avoids a
 * per-call `Object.entries()` array on the hot path (#4130).
 */
export function selectLiveCumulativeUsage(
  s: Pick<ConnectionState, 'sessionStates'>,
): LiveUsageMap {
  const out: LiveUsageMap = {}
  const states = s.sessionStates ?? {}
  for (const id in states) {
    out[id] = states[id]!.cumulativeUsage
  }
  return out
}

/**
 * Subscribe to the live usage map, re-rendering only when a value changes
 * (not on every stream chunk, #4120).
 *
 * `useShallow` is LOAD-BEARING: the selector returns a fresh object every
 * call, and zustand 5 subscribes through `useSyncExternalStore`, which
 * force-re-renders until React throws `Maximum update depth exceeded`
 * (minified #185) on mount, including with empty `sessionStates`.
 */
export function useLiveCumulativeUsage(): LiveUsageMap {
  return useConnectionStore(useShallow(selectLiveCumulativeUsage))
}

/** Live value wins; the snapshot is the fallback; absent in both is `null`. */
export function resolveSessionUsage(
  live: LiveUsageMap,
  session: Pick<SessionInfo, 'sessionId' | 'cumulativeUsage'>,
): CumulativeUsage | null {
  return live[session.sessionId] ?? session.cumulativeUsage ?? null
}

/**
 * Overlay live usage onto a `sessions` snapshot. `null`/`undefined` live
 * values fall back to the snapshot's own value; sessions whose usage is
 * unchanged keep their object identity.
 */
export function overlayLiveUsage(
  sessions: SessionInfo[],
  liveUsage: LiveUsageMap,
): SessionInfo[] {
  return sessions.map((session) => {
    const live = liveUsage[session.sessionId]
    if (live == null || live === session.cumulativeUsage) return session
    return { ...session, cumulativeUsage: live }
  })
}
