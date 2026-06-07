/**
 * LAN discovery of chroxy daemons (#5281 ③).
 *
 * Thin wrapper over the desktop Tauri `discover_lan_servers` command, which
 * browses `_chroxy._tcp` on the LAN. Outside Tauri (plain browser dashboard)
 * there's no mDNS access, so this resolves to an empty list — callers should
 * gate the UI on `isTauri()` rather than relying on the empty result.
 */
import { getTauriInvoke } from './tauri-bridge'

export interface DiscoveredServer {
  /** Daemon machine name (from the mDNS instance name), host fallback. */
  name: string
  host: string
  port: number
  /** ws:// endpoint, ready to pre-fill the add-server form. */
  wsUrl: string
  version: string | null
}

function isDiscoveredServer(v: unknown): v is DiscoveredServer {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    typeof o.host === 'string' &&
    typeof o.port === 'number' &&
    typeof o.wsUrl === 'string'
  )
}

/**
 * Browse the LAN for chroxy daemons. Returns `[]` outside Tauri or when the
 * browse finds nothing; rejects only on an actual command error so the caller
 * can surface "discovery failed" distinctly from "found nothing".
 */
export async function discoverLanServers(): Promise<DiscoveredServer[]> {
  const invoke = getTauriInvoke()
  if (!invoke) return []
  const result = await invoke('discover_lan_servers')
  if (!Array.isArray(result)) return []
  return result.filter(isDiscoveredServer)
}
