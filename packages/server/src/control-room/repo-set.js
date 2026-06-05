/**
 * Control Room v2 (#5172) — repo-set resolver.
 *
 * Resolves the set of repos the Host Status survey covers: the de-duped union
 * of explicit `config.repos[]` entries and git repositories auto-discovered
 * under a configurable discovery root.
 *
 * Pure server utility — no protocol dependency. The filesystem access is fully
 * injectable (`_readdir` / `_stat` / `_exists` / `_realpath`) so tests never
 * touch the real disk or the user's home directory.
 */

import { readdirSync, statSync, existsSync, realpathSync } from 'fs'
import { join, basename, resolve } from 'path'
import { homedir } from 'os'

/** Default discovery root when none is configured. */
export const DEFAULT_CONTROL_ROOM_ROOT = join(homedir(), 'Projects')

/**
 * Default filesystem injection seam. Real `fs`/`path` access lives here so the
 * resolver body never references the modules directly — tests pass a fake.
 */
function defaultFs() {
  return {
    // List immediate directory entries as names (strings).
    readdir: dir => readdirSync(dir),
    // Return { isDirectory(): boolean } for a path. Used to check that a
    // discovered entry is a directory.
    stat: p => statSync(p),
    // Whether a path exists. Used for the `.git` entry check (a `.git`
    // directory for a clone or a `.git` file for a worktree/submodule both
    // count — existence alone qualifies).
    exists: p => existsSync(p),
    // Canonical absolute path used as the de-dupe key. Falls back to the
    // input on failure (e.g. a symlink target that no longer resolves).
    realpath: p => realpathSync(p),
  }
}

/**
 * Auto-discover git repos that are immediate subdirectories of `root`.
 *
 * Only entries that (a) are directories and (b) contain a `.git` entry (either
 * a directory for a normal clone or a file for a worktree/submodule) qualify.
 *
 * @param {string} root - Discovery root (absolute path).
 * @param {object} fs - Filesystem seam (see defaultFs()).
 * @returns {Array<{ name: string, path: string }>} Discovered repos: `name` is
 *   the basename, `path` is the joined `root/entry` directory path (NOT the
 *   realpath — realpath is only computed later as the de-dupe key).
 */
function discoverRepos(root, fs) {
  let entries
  try {
    entries = fs.readdir(root)
  } catch {
    // Missing/unreadable root — nothing to discover.
    return []
  }

  const found = []
  for (const entry of entries) {
    const dirPath = join(root, entry)

    // Must be a directory.
    let st
    try {
      st = fs.stat(dirPath)
    } catch {
      continue
    }
    if (!st || !st.isDirectory()) continue

    // Must contain a `.git` entry (dir for a clone, file for a worktree).
    const gitPath = join(dirPath, '.git')
    try {
      if (!fs.exists(gitPath)) continue
    } catch {
      continue
    }

    found.push({ name: basename(dirPath), path: dirPath })
  }
  return found
}

/**
 * Resolve the absolute, canonical path for a repo entry, used as the de-dupe
 * key. Falls back to a non-canonical absolute path when realpath fails so a
 * not-yet-existing config entry still de-dupes against itself.
 *
 * @param {string} p - A repo path.
 * @param {object} fs - Filesystem seam.
 * @returns {string} The de-dupe key.
 */
function dedupeKey(p, fs) {
  const absolute = resolve(p)
  try {
    return fs.realpath(absolute)
  } catch {
    return absolute
  }
}

/**
 * Resolve the de-duped set of repos for the Host Status survey.
 *
 * The result is the union of:
 *   - explicit `repos[]` entries (`{ path, name? }`), and
 *   - git repos auto-discovered under `root` (default ~/Projects).
 *
 * De-duplication is by realpath; config entries win over discovered ones on a
 * collision (config order is preserved, discovered repos append after).
 *
 * @param {object} [opts]
 * @param {Array<{ path: string, name?: string }>} [opts.repos] - Explicit config repos.
 * @param {string} [opts.root] - Discovery root. Defaults to DEFAULT_CONTROL_ROOM_ROOT.
 * @param {Function} [opts._readdir] - Override for reading a directory (returns string[]).
 * @param {Function} [opts._stat] - Override for stat (returns { isDirectory() }).
 * @param {Function} [opts._exists] - Override for existence check (returns boolean).
 * @param {Function} [opts._realpath] - Override for realpath (returns string).
 * @returns {Array<{ name: string, path: string }>} De-duped repo set.
 */
export function resolveRepoSet(opts = {}) {
  const { repos = [], root, _readdir, _stat, _exists, _realpath } = opts

  const base = defaultFs()
  const fs = {
    readdir: _readdir || base.readdir,
    stat: _stat || base.stat,
    exists: _exists || base.exists,
    realpath: _realpath || base.realpath,
  }

  const effectiveRoot = root || DEFAULT_CONTROL_ROOM_ROOT

  const seen = new Set()
  const out = []

  // Config repos first so they win de-dupe collisions and keep their order.
  for (const repo of Array.isArray(repos) ? repos : []) {
    if (!repo || typeof repo.path !== 'string' || repo.path.length === 0) continue
    const key = dedupeKey(repo.path, fs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      name: typeof repo.name === 'string' && repo.name.length > 0 ? repo.name : basename(repo.path),
      path: repo.path,
    })
  }

  // Auto-discovered repos append after, skipping any already covered by config.
  for (const repo of discoverRepos(effectiveRoot, fs)) {
    const key = dedupeKey(repo.path, fs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(repo)
  }

  return out
}
