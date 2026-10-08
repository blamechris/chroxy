/**
 * StaleBundleBanner (#8268) — "Chroxy was updated — Reload".
 *
 * Shown when this page's bundle differs from what the daemon that served it runs now
 * (see utils/stale-bundle.ts), and the page did not reload itself because that would
 * have lost something (a composer draft, a staged attachment) or already tried once
 * for this very update. Persistent on purpose: the page is running code from before
 * the update, and the only honest resolution is a reload, which the user does when
 * they are ready.
 */
import type { StaleBundleInfo } from '../utils/stale-bundle'

export interface StaleBundleBannerProps {
  stale: StaleBundleInfo | null
  onReload: () => void
}

function describe(stale: StaleBundleInfo): string | null {
  const { clientVersion, serverVersion } = stale
  if (clientVersion && serverVersion && clientVersion !== serverVersion) {
    return `This window is running v${clientVersion}; the server is v${serverVersion}.`
  }
  return 'The server was rebuilt since this window loaded.'
}

export function StaleBundleBanner({ stale, onReload }: StaleBundleBannerProps) {
  if (!stale) return null
  return (
    <div className="stale-bundle-banner" data-testid="stale-bundle-banner" role="status" aria-live="polite">
      <span className="stale-bundle-message" data-testid="stale-bundle-message">Chroxy was updated — Reload</span>
      <span className="stale-bundle-detail" data-testid="stale-bundle-detail">{describe(stale)}</span>
      <button className="btn-retry" data-testid="stale-bundle-reload" onClick={onReload} type="button">
        Reload
      </button>
    </div>
  )
}
