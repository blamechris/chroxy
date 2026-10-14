import type { ProviderRuntimeInfo } from '@chroxy/protocol'

export type ComposerReadiness = {
  canSend: boolean
  status: 'ready' | 'synchronizing' | 'initializing'
}

/**
 * Derive input admissibility from the current socket's session-scoped runtime
 * snapshot. Every new connection epoch clears providerRuntimeInfo in both clients,
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

/** Compatibility until the runtime frame arrives. Codex can select either the
 * native or legacy driver, so it waits for that driver fact; all other current
 * providers retain their established startup/queue behavior. Runtime traits
 * always take precedence when present, including config-registered providers.
 */
export function providerInputReadinessFallback(provider: string | null | undefined): false | undefined {
  return provider && provider !== 'codex' && provider !== 'codex-appserver' ? false : undefined
}
