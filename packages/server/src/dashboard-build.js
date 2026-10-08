/**
 * The identity of the dashboard bundle this daemon serves (#8268).
 *
 * A long-lived dashboard tab (the desktop window, a browser tab) keeps running the
 * bundle it loaded even after the daemon is updated and restarted underneath it, and
 * its header reads the SERVER's version, which hides the staleness. The client needs
 * something to compare its own bundle against, and the package version is not enough:
 * a rebuilt `dist` at the same version (a dev rebuild, a hotfix that did not bump)
 * changes the code and not the number.
 *
 * The id is a hash of the built `index.html`. Vite names every JS and CSS asset by
 * content hash and `index.html` references the entry chunks by those names, so any
 * change to the shipped code changes the file, and nothing else does.
 *
 * Two places use it, and they must agree byte for byte:
 *   - `http-routes.js` injects it into the served HTML as `<meta name="chroxy-build">`,
 *     which is the id of the bundle THIS page loaded;
 *   - `ws-history.js` sends it in `auth_ok`, which is the id of the bundle the daemon
 *     serves NOW.
 * The client compares the two on connect.
 */
import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * Where the built dashboard lives: the workspace build (dev), else the copy the
 * Tauri bundle ships next to the server. The same choice the HTTP route makes, so
 * the id describes the files that are actually served.
 */
export function resolveDashboardDist() {
  const workspaceDist = join(__dirname, '..', '..', 'dashboard', 'dist')
  const bundleDist = join(__dirname, 'dashboard-next', 'dist')
  return existsSync(workspaceDist) ? workspaceDist : bundleDist
}

/** The build id of an `index.html` document (before any per-request injection). */
export function dashboardBuildIdOf(html) {
  return createHash('sha256').update(html).digest('hex').slice(0, 16)
}

// Keyed by the file's identity so a rebuilt `dist` is picked up on the next
// auth_ok with no daemon restart, while the common case (an unchanged file)
// costs one stat and no read.
let cache = { path: null, mtimeMs: -1, size: -1, id: null }

/**
 * The id of the dashboard currently on disk, or null when there is none (an
 * unbuilt checkout, a headless install). Null means "cannot say", never "equal":
 * the client treats it as no signal and falls back to comparing versions.
 *
 * @param {string} [distDir] - override for tests
 */
export function getDashboardBuildId(distDir = resolveDashboardDist()) {
  const indexPath = join(distDir, 'index.html')
  try {
    const st = statSync(indexPath)
    if (cache.path === indexPath && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.id) {
      return cache.id
    }
    const id = dashboardBuildIdOf(readFileSync(indexPath, 'utf-8'))
    cache = { path: indexPath, mtimeMs: st.mtimeMs, size: st.size, id }
    return id
  } catch {
    return null
  }
}
