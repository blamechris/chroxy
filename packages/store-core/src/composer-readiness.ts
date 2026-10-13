import type { ProviderRuntimeInfo } from '@chroxy/protocol'

export type ComposerReadiness = {
  canSend: boolean
  status: 'ready' | 'synchronizing' | 'initializing'
}

/**
 * Derive input admissibility from the current socket's session-scoped runtime
 * snapshot. Socket-close handling clears providerRuntimeInfo in both clients,
 * so a cached ready value cannot authorize a reconnect or another tab.
 */
export function deriveComposerReadiness(
  runtimeInfo: ProviderRuntimeInfo | null | undefined,
  knownInputRequiresReady?: boolean,
): ComposerReadiness {
  if (!runtimeInfo) {
    return knownInputRequiresReady === false
      ? { canSend: true, status: 'ready' }
      : { canSend: false, status: 'synchronizing' }
  }
  if (!runtimeInfo.inputRequiresReady) return { canSend: true, status: 'ready' }
  const inputReady = runtimeInfo.capabilities.find(({ name }) => name === 'inputReady')?.state
  return inputReady === true
    ? { canSend: true, status: 'ready' }
    : { canSend: false, status: 'initializing' }
}
