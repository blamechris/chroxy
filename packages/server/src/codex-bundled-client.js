// #8609 — find the codex client bundled inside a desktop app, so a session
// launched on an older PATH `codex` can say a newer one is installed.
//
// The ChatGPT / Codex desktop apps ship their own codex under
// `<App>.app/Contents/Resources/codex-cli/` with a `codex-package.json`
// manifest. We READ THE MANIFEST ONLY — never spawn the bundled binary to learn
// its version. Detection is advisory: it never throws, never selects a binary,
// and a missing/unreadable/garbage manifest is simply skipped.

import { readFileSync as nodeReadFileSync } from 'fs'
import { homedir } from 'os'
import { posix } from 'path'
import { parseSemver, compareSemver } from './codex-protocol-capabilities.js'

// macOS app-bundle paths only (darwin-gated below), so POSIX joins on every
// host keep the returned path and its tests platform-independent.
const { join, isAbsolute } = posix

const APP_NAMES = ['ChatGPT.app', 'Codex.app']
const MANIFEST_REL = join('Contents', 'Resources', 'codex-cli', 'codex-package.json')
const DEFAULT_ENTRYPOINT = join('bin', 'codex')
const MAX_MANIFEST_BYTES = 64 * 1024

function entrypointOf(manifest) {
  const e = manifest?.entrypoint
  // Relative and inside the package dir only: the path is shown to the operator
  // as something to put in CHROXY_CODEX_BIN, so it must not point elsewhere.
  if (typeof e === 'string' && e && !isAbsolute(e) && !e.split(/[\\/]/).includes('..')) return e
  return DEFAULT_ENTRYPOINT
}

/**
 * @param {{fs?: {readFileSync: Function}, platform?: string, home?: string}} [deps]
 * @returns {{path: string, version: string}|null} the newest bundled client, or null.
 */
export function findNewestBundledCodexClient({ fs, platform = process.platform, home } = {}) {
  if (platform !== 'darwin') return null
  const read = fs?.readFileSync || nodeReadFileSync
  let homeDir = home
  if (homeDir === undefined) {
    try { homeDir = homedir() } catch { homeDir = null }
  }
  const roots = ['/Applications']
  if (homeDir) roots.push(join(homeDir, 'Applications'))

  let best = null
  for (const root of roots) {
    for (const app of APP_NAMES) {
      try {
        const dir = join(root, app, 'Contents', 'Resources', 'codex-cli')
        const text = read(join(root, app, MANIFEST_REL), 'utf8')
        if (typeof text !== 'string' || text.length > MAX_MANIFEST_BYTES) continue
        const manifest = JSON.parse(text)
        const version = typeof manifest?.version === 'string' ? manifest.version : null
        const parsed = parseSemver(version)
        if (!parsed) continue
        if (!best || compareSemver(parsed, best.parsed) > 0) {
          best = { parsed, version, path: join(dir, entrypointOf(manifest)) }
        }
      } catch {
        // missing / unreadable / garbage manifest: not installed, as far as we can tell
      }
    }
  }
  return best ? { path: best.path, version: best.version } : null
}
