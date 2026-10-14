import type { SavedConnection } from './types/connection'
import type { KeyPinDecision } from './key-pinning'

export interface ConnectionIdentityTarget {
  pinnedIdentityKey: string | null
  pairingIdentityKey: string | null
  savedConnection: SavedConnection | null
}

export function connectionMatchesEndpoint(saved: SavedConnection | null | undefined, url: string): boolean {
  return !!saved && [saved.url, saved.lanUrl, saved.tunnelUrl].includes(url)
}

/** Snapshot the record and trusted pairing identity belonging to this dial. */
export function captureConnectionIdentity(url: string, saved: SavedConnection | null | undefined, pairingIdentityKey: string | null): ConnectionIdentityTarget {
  const record = connectionMatchesEndpoint(saved, url) ? { ...saved! } : null
  return {
    pinnedIdentityKey: pairingIdentityKey ? null : record?.pinnedIdentityKey ?? null,
    pairingIdentityKey,
    savedConnection: record,
  }
}

export function effectiveConnectionIdentity(target: ConnectionIdentityTarget, decision: Exclude<KeyPinDecision, { action: 'refuse' }>): string | null {
  return decision.action === 'connect' ? target.pinnedIdentityKey : decision.identityKey
}

/** Continue the same owned connection using its last verified identity. */
export function reconnectConnectionIdentity(target: ConnectionIdentityTarget, verifiedIdentityKey: string | null | undefined, savedConnection?: SavedConnection | null): ConnectionIdentityTarget {
  return {
    pinnedIdentityKey: verifiedIdentityKey ?? target.pinnedIdentityKey ?? target.pairingIdentityKey,
    pairingIdentityKey: null,
    savedConnection: savedConnection ?? target.savedConnection,
  }
}
