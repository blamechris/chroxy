/**
 * The commit this daemon was started from (#8324).
 *
 * The idle-only auto-deploy (`scripts/deploy-daemon.mjs`) must know what the
 * RUNNING process is, not infer it from pids and journals: after a restart it
 * counts only if the daemon itself reports the desired commit. So the daemon
 * resolves it once, at startup, from its own checkout.
 *
 * `git rev-parse HEAD` is run at the repo root derived from this file's
 * location, and the answer is accepted only if git says that directory IS the
 * top level of a checkout: a server installed under `node_modules` inside some
 * other project would otherwise report THAT project's HEAD. Any failure
 * (git missing, not a checkout, timeout, odd output) is `null`; this never throws.
 */
import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path, { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROXY_INHERITED_SESSION_ENV, CHROXY_SECRET_DENYLIST, stripInheritedChroxySecrets } from './utils/spawn-env.js'

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * @param {string} dir - the directory that must be the root of a git checkout
 * @param {{ spawn?: Function }} [deps]
 * @returns {string|null} 40-hex HEAD, or null
 */
export function resolveRepoCommit(dir, { spawn = spawnSync } = {}) {
  // One retry: a CPU spike at restart can time a single attempt out, and a good
  // build that reports `commit: null` is judged unverified and rolled back.
  return attempt(dir, spawn) ?? attempt(dir, spawn)
}

/**
 * Are these two paths the same directory? `git rev-parse --show-toplevel` prints
 * forward slashes even on Windows (`A:/runners/x`), and a CI runner's temp path
 * can be an 8.3 short name, so a string compare of the two is wrong there.
 * Both sides go through `realpath.native` (which expands short names) and the
 * platform's own `resolve` (which normalises the separators), then compare
 * case-insensitively on Windows only. Pure: the platform, `path` module and
 * realpath are parameters so Windows-shaped inputs are testable anywhere.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ path?: typeof path, realpath?: (p: string) => string, windows?: boolean }} [deps]
 */
export function isSameDirectory(a, b, { path: p = path, realpath = realpathSync.native, windows = process.platform === 'win32' } = {}) {
  try {
    const norm = (x) => {
      const r = p.resolve(realpath(p.resolve(x)))
      return windows ? r.toLowerCase() : r
    }
    return norm(a) === norm(b)
  } catch {
    return false
  }
}

// The environment git is spawned with. EVERY GIT_* variable goes, not a
// hand-picked few: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_CEILING_DIRECTORIES,
// GIT_CONFIG_* ... each can point git at some other repository or change what it
// prints. And git has no use for the daemon's own secrets (API_TOKEN, the hook
// and ingest secrets), so those are stripped too.
function buildGitEnv() {
  // Keys are compared case-INSENSITIVELY: Windows treats `Git_Dir` as `GIT_DIR`.
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v
  stripInheritedChroxySecrets(env)
  const secret = new Set([...CHROXY_SECRET_DENYLIST, ...CHROXY_INHERITED_SESSION_ENV].map((k) => k.toUpperCase()))
  for (const k of Object.keys(env)) if (secret.has(k.toUpperCase())) delete env[k]
  return env
}

function attempt(dir, spawn) {
  try {
    const r = spawn('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: 5000, env: buildGitEnv(), stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null
    const [top, sha, ...extra] = r.stdout.trim().split('\n')
    if (extra.length > 0 || !FULL_SHA.test(sha ?? '')) return null
    if (!isSameDirectory(top, dir)) return null
    return sha
  } catch {
    return null
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Resolved once, when the daemon loads this module. */
export const DAEMON_COMMIT = resolveRepoCommit(REPO_ROOT)
