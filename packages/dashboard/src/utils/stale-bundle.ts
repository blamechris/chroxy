/**
 * Detecting and recovering from a dashboard page that outlived a daemon update
 * (#8268).
 *
 * The desktop loader navigates to the daemon's `/dashboard` once, and a WebSocket
 * reconnect does not reload the page. After an update the window therefore keeps the
 * previous bundle while its header reads the NEW server's version. A fix shipped in
 * that update looked broken until a quit and relaunch.
 *
 * On connect the client compares the build it loaded with what the daemon serves now:
 *  - `<meta name="chroxy-build">` (injected into the HTML by the daemon) is the id of
 *    the bundle this page loaded; `auth_ok.dashboardBuildId` is the id of the bundle on
 *    disk now. Both are hashes of the built `index.html`, so this catches a rebuilt
 *    dist at the SAME version.
 *  - When either id is missing (an older daemon, no built dist, the Vite dev server)
 *    it falls back to comparing the package version baked into the bundle with the
 *    server's.
 *
 * Only the daemon that served the page is judged (see daemon-origin.ts): a LAN server
 * in the registry runs a different build by design.
 */
import { hasUnsavedWork } from './unsaved-work'

declare const __APP_VERSION__: string

export interface StaleBundleInfo {
  clientVersion: string | null
  clientBuildId: string | null
  serverVersion: string | null
  serverBuildId: string | null
}

/** The version baked into this bundle at build time, or null outside a Vite build. */
export function getClientVersion(): string | null {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null
}

/** The id of the bundle this page loaded (the daemon's `<meta name="chroxy-build">`). */
export function getClientBuildId(): string | null {
  if (typeof document === 'undefined') return null
  const v = document.querySelector('meta[name="chroxy-build"]')?.getAttribute('content')
  return v ? v : null
}

/**
 * Pure verdict. Returns the info to display when the bundle is stale, else null.
 * An id present on both sides decides alone: equal ids with different versions is a
 * dev/proxy artefact, not a stale page.
 */
export function detectStaleBundle(input: StaleBundleInfo): StaleBundleInfo | null {
  const { clientBuildId, serverBuildId, clientVersion, serverVersion } = input
  let stale: boolean
  if (clientBuildId && serverBuildId) {
    stale = clientBuildId !== serverBuildId
  } else if (clientVersion && serverVersion) {
    stale = clientVersion !== serverVersion
  } else {
    stale = false
  }
  return stale ? { clientVersion, clientBuildId, serverVersion, serverBuildId } : null
}

// ---- reload ----------------------------------------------------------------

let reloader: () => void = () => { window.location.reload() }

/** Reload the page. */
export function reloadPage(): void {
  reloader()
}

/** Test seam: replace the reload (jsdom cannot navigate). Returns a restore function. */
export function setPageReloader(fn: () => void): () => void {
  const prev = reloader
  reloader = fn
  return () => { reloader = prev }
}

// ---- auto-reload decision --------------------------------------------------

const GUARD_KEY = 'chroxy.staleBundleReload'
/** A reload for the same target inside this window that still finds the page stale is not retried. */
export const RELOAD_GUARD_WINDOW_MS = 10 * 60 * 1000

function targetKey(info: StaleBundleInfo): string {
  return info.serverBuildId ?? `v${info.serverVersion ?? '?'}`
}

export type StaleBundleAction = 'reloaded' | 'banner'

/**
 * Reload now if that loses nothing, else leave the persistent banner to the user.
 *
 * Two things make it `banner`:
 *  - unsaved work (see unsaved-work.ts): a reload would destroy it, and the user can
 *    finish and click Reload themselves;
 *  - a loop guard: the reload we already did for this very target came back stale
 *    (a cached HTML, a proxy in front, the dev server). Reloading again would spin, so
 *    the second sighting shows the banner. The guard lives in sessionStorage so it
 *    survives the reload it protects; if storage is unavailable no guard can exist, so
 *    the answer is `banner` rather than a reload that could loop.
 */
export function handleStaleBundle(info: StaleBundleInfo, now: number = Date.now()): StaleBundleAction {
  if (hasUnsavedWork()) return 'banner'
  const key = targetKey(info)
  try {
    const raw = window.sessionStorage.getItem(GUARD_KEY)
    if (raw) {
      const prev = JSON.parse(raw) as { key?: unknown; at?: unknown }
      if (prev.key === key && typeof prev.at === 'number' && now - prev.at < RELOAD_GUARD_WINDOW_MS) {
        return 'banner'
      }
    }
    window.sessionStorage.setItem(GUARD_KEY, JSON.stringify({ key, at: now }))
  } catch {
    return 'banner'
  }
  reloadPage()
  return 'reloaded'
}
