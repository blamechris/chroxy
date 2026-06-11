/**
 * chatExpandRegistry — id-keyed expand-state registry for the virtualized
 * ChatView (#5561, mirroring the mobile #5534 pattern).
 *
 * Why this exists
 * ---------------
 * Before #5561 the dashboard ChatView mounted every message row at once, so a
 * tool bubble / tool group's local `useState(expanded)` survived for the whole
 * session — scrolling never unmounted it. #5561 virtualizes the list: rows that
 * scroll out of the window unmount and remount when scrolled back. A row-local
 * `useState` resets to its initial value on every remount, so a user who
 * expanded a Bash result, scrolled past it, and scrolled back would find it
 * snapped shut.
 *
 * The mobile app (#5534) solved the identical problem by lifting the expand
 * flags OUT of the recyclable row into a parent-held registry keyed by message
 * id, threaded down as `getInitialExpanded` / `onExpandedChange`. This module is
 * the dashboard equivalent: a tiny registry exposed through React context so the
 * `renderMessage`-produced `ToolBubble` / `ToolGroup` rows (defined in App.tsx,
 * not ChatView) can read and write it without ChatView having to grow new props
 * on every renderer.
 *
 * Design notes
 * ------------
 * - The registry lives in a `useRef` inside ChatView (one per ChatView
 *   instance) so writes never trigger a ChatView re-render — a recycled row
 *   re-reads it on its own mount, exactly like the mobile `expandedIdsRef`.
 * - Keys are message ids for single bubbles and the synthetic group key for
 *   tool groups; per-entry expand flags inside a group are namespaced with an
 *   `entry:` prefix so they never collide with a sibling row's id.
 * - Outside a provider (e.g. a ToolBubble rendered in a non-virtualized test or
 *   a different surface) the context falls back to a no-op registry, so the
 *   component keeps its pre-#5561 row-local behaviour unchanged.
 */
import { createContext, useCallback, useContext } from 'react'

export interface ChatExpandRegistry {
  /**
   * Read the persisted expand flag for `key`. Returns `undefined` when the
   * registry has never seen the key — callers treat that as "use the
   * component's own default" (e.g. `isTail`), so first-mount behaviour is
   * unchanged.
   */
  get(key: string): boolean | undefined
  /** Persist `expanded` for `key`. Cleared keys are deleted to keep the map small. */
  set(key: string, expanded: boolean): void
}

/** A registry that remembers nothing — the off-context fallback. */
const NOOP_REGISTRY: ChatExpandRegistry = {
  get: () => undefined,
  set: () => {},
}

export const ChatExpandContext = createContext<ChatExpandRegistry>(NOOP_REGISTRY)

/**
 * Resolve the persisted expand state for a row, falling back to the
 * component's own default when the registry has no opinion yet.
 *
 * `fallback` is the pre-registry initial value (e.g. `isTail` for a trailing
 * bubble) so a row that has never been toggled mounts exactly as it did before
 * #5561.
 */
export function useInitialExpanded(key: string, fallback: boolean): {
  initial: boolean
  persist: (expanded: boolean) => void
} {
  const registry = useContext(ChatExpandContext)
  const stored = registry.get(key)
  // Memoize `persist` on its only inputs (the registry — a stable map ref held
  // in a ChatView `useRef` — and the row key) so consumers can list it in effect
  // dep arrays honestly. ChatView's registry identity is stable for the
  // component's lifetime, so this returns the SAME function across renders for a
  // given key; without it the closure was fresh every render and ToolGroup had
  // to silence react-hooks/exhaustive-deps with a (misleading) "stable" comment.
  const persist = useCallback(
    (expanded: boolean) => registry.set(key, expanded),
    [registry, key],
  )
  return {
    initial: stored ?? fallback,
    persist,
  }
}

export { NOOP_REGISTRY }
