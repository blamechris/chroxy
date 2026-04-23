import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'

/**
 * Check whether dependency resolution will succeed from a given package
 * directory, across both package-local and hoisted (workspace) layouts.
 *
 * npm workspaces may place deps in any parent node_modules/ up the tree,
 * not just the package's own node_modules/. This helper mirrors what Node
 * will actually do at import time:
 *
 *   1. Try createRequire(startDir).resolve(probe) — the authoritative check.
 *      Matches Node's real module resolution, including symlinks, custom
 *      exports, and nested workspace layouts.
 *   2. Fall back to walking up from startDir looking for
 *      node_modules/<probe>/ — useful when createRequire throws for an
 *      unrelated reason (malformed package.json, ENOENT races, etc.).
 *
 * @param {Object} options
 * @param {string} options.startDir - Absolute path to begin resolution from
 *   (typically the server package root).
 * @param {string[]} options.probes - Dependency names to probe. Succeeds if
 *   ANY probe resolves. Pass multiple to be robust against a single dep
 *   being removed from package.json in the future.
 * @returns {{ ok: boolean, foundAt?: string, message?: string }}
 */
export function checkDependencies({ startDir, probes }) {
  if (!startDir || !Array.isArray(probes) || probes.length === 0) {
    return { ok: false, message: 'invalid arguments: startDir and non-empty probes required' }
  }

  // 1. createRequire probe — closest to what Node does at import time.
  // createRequire needs a file URL (or a filename); use a synthetic
  // file path inside startDir so Node walks up from there.
  const requireFromStart = createRequire(pathToFileURL(join(startDir, 'package.json')))
  for (const probe of probes) {
    try {
      const resolved = requireFromStart.resolve(probe)
      if (resolved) return { ok: true, foundAt: resolved }
    } catch {
      // fall through
    }
  }

  // 2. Walk-up fallback: look for node_modules/<probe>/ in each ancestor.
  // Stops at the filesystem root (when dirname returns the same path).
  let dir = startDir
  // Safety cap — real trees never exceed a few dozen levels.
  for (let i = 0; i < 64; i++) {
    for (const probe of probes) {
      const candidate = join(dir, 'node_modules', probe)
      if (existsSync(candidate)) {
        return { ok: true, foundAt: candidate }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return {
    ok: false,
    message: `no node_modules containing ${probes.join(' or ')} found walking up from ${startDir}`,
  }
}
