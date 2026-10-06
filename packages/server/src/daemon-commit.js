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
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FULL_SHA = /^[0-9a-f]{40}$/

/**
 * @param {string} dir - the directory that must be the root of a git checkout
 * @param {{ spawn?: Function }} [deps]
 * @returns {string|null} 40-hex HEAD, or null
 */
export function resolveRepoCommit(dir, { spawn = spawnSync } = {}) {
  try {
    const env = { ...process.env }
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) delete env[k]
    const r = spawn('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
      cwd: dir, encoding: 'utf8', timeout: 2000, env, stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null
    const [top, sha, ...extra] = r.stdout.trim().split('\n')
    if (extra.length > 0 || !FULL_SHA.test(sha ?? '')) return null
    if (realpathSync(top) !== realpathSync(dir)) return null
    return sha
  } catch {
    return null
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** Resolved once, when the daemon loads this module. */
export const DAEMON_COMMIT = resolveRepoCommit(REPO_ROOT)
