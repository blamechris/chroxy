import { useState, useEffect } from 'react'

/**
 * Track whether a configured tunnel is fully ready (connection info available).
 *
 * Extracted from App.tsx (#5560). When connected, polls `/connect` (or the
 * Tauri `getServerInfo` IPC) to learn whether a configured Cloudflare tunnel
 * has finished warming. Resets to ready whenever the socket drops so the
 * footer / status dot don't get stuck on a stale "warming" state.
 *
 * Behaviour is byte-identical to the inline effect it replaces — same deps
 * (`[isConnected]`), same dynamic imports, same 3s retry cadence.
 */
export function useTunnelReady(isConnected: boolean): boolean {
  const [tunnelReady, setTunnelReady] = useState(true)
  useEffect(() => {
    if (!isConnected) { setTunnelReady(true); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    async function checkTunnel() {
      try {
        const { getServerInfo } = await import('./useTauriIPC')
        const info = await getServerInfo()
        // Only track tunnel readiness if tunnel mode is configured
        if (!info || info.tunnelMode === 'none') { setTunnelReady(true); return }
      } catch {
        // Not in Tauri — check /connect directly
      }
      try {
        const { getAuthToken } = await import('../utils/auth')
        const token = getAuthToken()
        if (!token) return
        const res = await fetch('/connect', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) { if (!cancelled) setTunnelReady(true); return }
      } catch { /* ignore */ }
      if (!cancelled) { setTunnelReady(false); timer = setTimeout(checkTunnel, 3000) }
    }
    checkTunnel()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [isConnected])
  return tunnelReady
}
