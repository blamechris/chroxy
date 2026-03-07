/**
 * Server Registry — manages multiple Chroxy server connections.
 *
 * Stores server configurations (URL + token) and provides
 * add/remove/switch operations. The dashboard connects to one
 * server at a time; switching disconnects from the current
 * server and connects to the new one.
 */

const STORAGE_KEY = 'chroxy_server_registry'

export interface ServerEntry {
  /** Unique ID for this server (stable across renames) */
  id: string
  /** User-defined display name */
  name: string
  /** WebSocket URL (e.g. wss://my-server.example.com/ws) */
  wsUrl: string
  /** Auth token for this server */
  token: string
  /** Timestamp of last successful connection */
  lastConnectedAt: number | null
}

/** Generate a short unique ID */
function generateId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Load server list from localStorage */
export function loadServerRegistry(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Save server list to localStorage */
export function saveServerRegistry(servers: ServerEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers))
  } catch {
    // Storage not available
  }
}

// ---------------------------------------------------------------------------
// Operations — return new arrays, caller updates store
// ---------------------------------------------------------------------------

/** Add a new server entry. Returns [updatedList, newEntry]. */
export function addServerEntry(
  servers: ServerEntry[],
  name: string,
  wsUrl: string,
  token: string,
): [ServerEntry[], ServerEntry] {
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
  if (patch.wsUrl !== undefined) trimmed.wsUrl = patch.wsUrl.trim()
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
