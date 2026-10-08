/**
 * "Is this WebSocket URL the daemon that served this page?" (#8268)
 *
 * Two behaviours depend on the answer, and both are wrong for a daemon the page did
 * NOT come from:
 *
 *  - The mobile app's reconnect cap (#5698, #5725) exists so a client that cannot
 *    know whether its server is coming back stops spinning. A dashboard served BY the
 *    daemon it talks to is in the opposite position: the daemon is the machine's own
 *    process, an update restarts it for minutes, and giving up loses the session view
 *    after every update. It retries with no cap.
 *  - A stale bundle can only be judged against the server that SERVES the bundle. A
 *    registry entry for another LAN host is a different build by design, and comparing
 *    against it would reload the page forever.
 *
 * Same origin is the robust signal: it needs no configuration and holds for the
 * desktop window (the loader navigates to the daemon's `/dashboard`), a browser tab on
 * the LAN, and a tab reached through the tunnel. The Tauri case is widened for the
 * reconnect decision only: a desktop window's loopback target is its own machine's
 * daemon even when the page was loaded from a differently spelled loopback host.
 */
import { isTauri } from './tauri'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function effectivePort(u: URL): string {
  if (u.port) return u.port
  return u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80'
}

/** `localhost`, `127.0.0.1` and `[::1]` are one host for this comparison. */
function normalizedHost(u: URL): string {
  return LOOPBACK_HOSTS.has(u.hostname) ? 'loopback' : u.hostname
}

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

/** True when `wsUrl` points at the origin this page was loaded from. */
export function isOwnDaemonUrl(wsUrl: string): boolean {
  if (typeof window === 'undefined') return false
  const target = parse(wsUrl)
  const page = parse(window.location.href)
  if (!target || !page) return false
  // A page that is not http(s) (tauri://localhost splash, file://) was not served by a daemon.
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false
  return normalizedHost(target) === normalizedHost(page) && effectivePort(target) === effectivePort(page)
}

/**
 * True when reconnecting to `wsUrl` should never give up: the daemon that served this
 * page, or, in the desktop app, any loopback daemon (the local one).
 */
export function isLocalDaemonUrl(wsUrl: string): boolean {
  if (isOwnDaemonUrl(wsUrl)) return true
  if (!isTauri()) return false
  const target = parse(wsUrl)
  return target !== null && LOOPBACK_HOSTS.has(target.hostname)
}
