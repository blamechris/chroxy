import { useSyncExternalStore } from 'react'
import { isReplayInProgress, subscribeReplayWindows } from '@chroxy/store-core'

/**
 * #8231 — reactive "is this session's history replay still arriving?". Backed
 * by store-core's replay window (opened at `history_replay_start`, closed at
 * `history_replay_end`, abandoned on disconnect/auth reset), so it needs no
 * extra bookkeeping in the connection store's reset rosters.
 */
export function useReplayInProgress(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribeReplayWindows,
    () => isReplayInProgress(sessionId),
    () => false,
  )
}
