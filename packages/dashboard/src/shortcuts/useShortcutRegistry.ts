/**
 * React glue for the shortcut registry (#3852).
 *
 * Exposes a module-level singleton built from `DEFAULT_SHORTCUTS` plus a
 * React hook that re-renders subscribers when bindings change. We use a
 * singleton (rather than React context) because the registry needs to
 * be reachable from the global keydown handler in App.tsx without
 * threading a context value through unrelated subtrees.
 *
 * Tests can swap out the singleton via `__setSharedRegistryForTesting`.
 */
import { useSyncExternalStore } from 'react'
import { createShortcutRegistry, type ShortcutRegistry } from './registry'
import { DEFAULT_SHORTCUTS } from './defaults'

interface SharedState {
  registry: ShortcutRegistry
  // Monotonically-incremented every time a binding changes. This is
  // what `useSyncExternalStore` compares — we can't return `registry`
  // itself because it's a stable reference and React would skip the
  // re-render.
  version: number
  notify: () => void
  subscribers: Set<() => void>
}

function makeShared(registry: ShortcutRegistry): SharedState {
  const state: SharedState = {
    registry,
    version: 0,
    subscribers: new Set(),
    notify: () => { /* replaced below once `state` exists */ },
  }
  state.notify = () => {
    state.version += 1
    for (const fn of state.subscribers) fn()
  }
  registry.subscribe(state.notify)
  return state
}

let shared: SharedState = makeShared(createShortcutRegistry(DEFAULT_SHORTCUTS))

export function getSharedShortcutRegistry(): ShortcutRegistry {
  return shared.registry
}

/**
 * Test-only setter. Production code should never call this — it exists
 * so unit tests can install a fresh registry between cases without
 * resorting to module-cache hacks.
 */
export function __setSharedRegistryForTesting(next: ShortcutRegistry): void {
  shared = makeShared(next)
}

/**
 * Subscribe to the shared registry and re-render whenever a binding
 * changes. Returns the live registry so consumers can call `list()`,
 * `getBinding()`, etc. on it.
 */
export function useShortcutRegistry(): ShortcutRegistry {
  useSyncExternalStore(
    listener => {
      shared.subscribers.add(listener)
      return () => { shared.subscribers.delete(listener) }
    },
    () => shared.version,
    () => shared.version,
  )
  return shared.registry
}
