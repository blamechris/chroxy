/**
 * Server Registry — manages multiple Chroxy server connections.
 *
 * Stores server configurations (URL + token) and provides
 * add/remove/switch operations. The dashboard connects to one
 * server at a time; switching disconnects from the current
 * server and connects to the new one.
 */

import type { ServerEntry } from './types'
import { obfuscateToken, deobfuscateToken, isProtected } from './token-crypto'

const STORAGE_KEY = 'chroxy_server_registry'

export type { ServerEntry }

/** Generate a short unique ID */
function generateId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load server list from localStorage, decrypting tokens */
export function loadServerRegistry(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Deobfuscate tokens on load (handles both plaintext and obfuscated)
    let needsMigration = false
    const entries = parsed.map((entry: ServerEntry) => {
      if (entry.token && isProtected(entry.token)) {
        return { ...entry, token: deobfuscateToken(entry.token) }
      }
      if (entry.token) needsMigration = true
      return entry
    })
    // If any tokens were plaintext, re-save with obfuscation
    if (needsMigration) {
      saveServerRegistry(entries)
    }
    return entries
  } catch {
    return []
  }
}

/** Save server list to localStorage, obfuscating tokens */
export function saveServerRegistry(servers: ServerEntry[]): void {
  try {
    const protected_ = servers.map(s => ({
      ...s,
      token: s.token ? obfuscateToken(s.token) : s.token,
    }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(protected_))
  } catch {
    // Storage not available
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate a WebSocket URL. Returns null if valid, or an error message. */
export function validateWsUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return 'URL is required'
  if (!/^wss?:\/\//i.test(trimmed)) return 'URL must start with ws:// or wss://'
  try {
    new URL(trimmed)
  } catch {
    return 'Invalid URL format'
  }
  return null
}

// ---------------------------------------------------------------------------
// Operations — return new arrays, caller updates store
// ---------------------------------------------------------------------------

/** Add a new server entry. Returns [updatedList, newEntry]. Throws on invalid URL. */
export function addServerEntry(
  servers: ServerEntry[],
  name: string,
  wsUrl: string,
  token: string,
): [ServerEntry[], ServerEntry] {
  const urlError = validateWsUrl(wsUrl)
  if (urlError) throw new Error(urlError)
  const entry: ServerEntry = {
    id: generateId(),
    name: name.trim() || 'Unnamed Server',
    wsUrl: wsUrl.trim(),
    token: token.trim(),
    lastConnectedAt: null,
  }
  const updated = [...servers, entry]
  saveServerRegistry(updated)
  return [updated, entry]
}

/** Remove a server entry by ID. Returns updated list. */
export function removeServerEntry(servers: ServerEntry[], serverId: string): ServerEntry[] {
  const updated = servers.filter(s => s.id !== serverId)
  saveServerRegistry(updated)
  return updated
}

/** Update a server entry (name, url, or token). Returns updated list. */
export function updateServerEntry(
  servers: ServerEntry[],
  serverId: string,
  patch: Partial<Pick<ServerEntry, 'name' | 'wsUrl' | 'token'>>,
): ServerEntry[] {
  const trimmed: typeof patch = {}
  if (patch.name !== undefined) trimmed.name = patch.name.trim() || 'Unnamed Server'
  if (patch.wsUrl !== undefined) {
    const urlError = validateWsUrl(patch.wsUrl)
    if (urlError) throw new Error(urlError)
    trimmed.wsUrl = patch.wsUrl.trim()
  }
  if (patch.token !== undefined) trimmed.token = patch.token.trim()
  const updated = servers.map(s =>
    s.id === serverId ? { ...s, ...trimmed } : s,
  )
  saveServerRegistry(updated)
  return updated
}

/** Mark a server as successfully connected. Returns updated list. */
export function markServerConnected(servers: ServerEntry[], serverId: string): ServerEntry[] {
  const updated = servers.map(s =>
    s.id === serverId ? { ...s, lastConnectedAt: Date.now() } : s,
  )
  saveServerRegistry(updated)
  return updated
}

/** Find a server entry by its WebSocket URL */
export function findServerByUrl(servers: ServerEntry[], wsUrl: string): ServerEntry | undefined {
  return servers.find(s => s.wsUrl === wsUrl)
}
