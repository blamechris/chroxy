/**
 * docker-byok compose-project-id persistence (#5081).
 *
 * `DockerByokSession` generates `_composeProject = 'chroxy-byok-<rand-hex>'`
 * lazily inside `_startComposeStack`. Held in memory only, a daemon crash /
 * SIGKILL between `docker compose up` and `docker compose down` leaks the
 * whole stack with no on-disk paper trail.
 *
 * This store mirrors EnvironmentManager's on-disk shape (`{ version, stacks }`,
 * atomic restricted write) so each running compose stack leaves a durable
 * record. A boot-time `sweepOrphanedComposeStacks()` then runs
 * `docker compose down --remove-orphans` against every leftover project id
 * before any new sessions launch.
 *
 * State-file shape:
 *   {
 *     "version": 1,
 *     "stacks": [
 *       { "projectId": "chroxy-byok-ab12cd", "composeFile": "/proj/docker-compose.yml",
 *         "cwd": "/work/proj", "createdAt": "2026-06-03T..." }
 *     ]
 *   }
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { writeFileRestricted } from './platform.js'

const STATE_VERSION = 1

/**
 * #5124 — A persisted compose file may be a single path or an array of paths
 * (base + override overlay). Valid when it's a non-empty string, or a
 * non-empty array of non-empty strings.
 * @param {*} composeFile
 * @returns {boolean}
 */
function isValidComposeFile(composeFile) {
  if (typeof composeFile === 'string') return composeFile.length > 0
  if (Array.isArray(composeFile)) {
    return composeFile.length > 0 && composeFile.every((f) => typeof f === 'string' && f.length > 0)
  }
  return false
}

/**
 * #5124 — Defensive copy so the store never aliases a caller-provided array.
 * Strings are immutable and returned as-is; arrays are shallow-cloned so a
 * later mutation by the caller can't change persisted state (or what a prior
 * `list()` consumer sees).
 * @param {string|string[]} composeFile
 * @returns {string|string[]}
 */
function cloneComposeFile(composeFile) {
  return Array.isArray(composeFile) ? [...composeFile] : composeFile
}

/**
 * Default on-disk location, mirroring environment-manager.js's
 * `~/.chroxy/environments.json`. Honors CHROXY_CONFIG_DIR like the rest of
 * the docker-byok stack does.
 */
export const DEFAULT_BYOK_COMPOSE_STATE_PATH = join(
  process.env.CHROXY_CONFIG_DIR || join(homedir(), '.chroxy'),
  'byok-compose-state.json',
)

/**
 * Synchronous, crash-durable store of live compose project ids.
 *
 * Every mutation persists immediately via `writeFileRestricted` (atomic on
 * POSIX + Windows, mode 0600) so a crash right after the in-memory mutation
 * still leaves the durable record the boot sweep relies on.
 */
export class ByokComposeStateStore {
  /**
   * @param {object}  opts
   * @param {string} [opts.statePath] - On-disk path for byok-compose-state.json.
   */
  constructor({ statePath } = {}) {
    this._statePath = statePath || DEFAULT_BYOK_COMPOSE_STATE_PATH
    // Map<projectId, entry> so record() on an existing id replaces in place
    // and forget() is O(1). Insertion order is preserved by Map iteration.
    this._stacks = new Map()
    this._load()
  }

  /**
   * Record (or replace) a live compose stack and persist to disk.
   *
   * @param {object} entry
   * @param {string} entry.projectId   - Compose project id (chroxy-byok-<hex>).
   * @param {string|string[]} entry.composeFile - Absolute path to the compose
   *   file, or an ARRAY of paths for a base + override overlay (#5124). The
   *   boot sweep replays the same `-f` set so the merged config — and thus the
   *   stack torn down — matches the one brought up.
   * @param {string} entry.cwd         - Working directory the stack runs in.
   */
  record({ projectId, composeFile, cwd } = {}) {
    if (!projectId || typeof projectId !== 'string') {
      throw new Error('record() requires a non-empty projectId')
    }
    if (!isValidComposeFile(composeFile)) {
      throw new Error('record() requires a non-empty composeFile (string or array of strings)')
    }
    if (!cwd || typeof cwd !== 'string') {
      throw new Error('record() requires a non-empty cwd')
    }
    this._stacks.set(projectId, {
      projectId,
      composeFile: cloneComposeFile(composeFile),
      cwd,
      createdAt: new Date().toISOString(),
    })
    this._persist()
  }

  /**
   * Remove a stack by project id and persist. No-op if unknown.
   */
  forget(projectId) {
    if (this._stacks.delete(projectId)) {
      this._persist()
    }
  }

  /**
   * Snapshot of all recorded stacks (insertion order).
   * @returns {Array<{projectId:string, composeFile:string|string[], cwd:string, createdAt:string}>}
   */
  list() {
    return Array.from(this._stacks.values()).map((s) => ({ ...s, composeFile: cloneComposeFile(s.composeFile) }))
  }

  _persist() {
    try {
      const dir = dirname(this._statePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const data = {
        version: STATE_VERSION,
        stacks: Array.from(this._stacks.values()),
      }
      // writeFileRestricted is atomic on both POSIX and Windows and cleans
      // up its intermediate `.tmp` on rename failure — no manual tmp+rename
      // wrapper needed.
      writeFileRestricted(this._statePath, JSON.stringify(data, null, 2))
    } catch (err) {
      // Persistence is best-effort: a write failure must not take down the
      // session that triggered it. The worst case degrades back to the
      // pre-#5081 "in-memory only" behaviour.
      // eslint-disable-next-line no-console
      console.warn(`[byok-compose-state] failed to persist: ${err.message}`)
    }
  }

  _load() {
    if (!existsSync(this._statePath)) return
    try {
      const data = JSON.parse(readFileSync(this._statePath, 'utf-8'))
      if (!data || data.version !== STATE_VERSION || !Array.isArray(data.stacks)) {
        // Unknown version or corrupt shape — ignore rather than crash.
        return
      }
      for (const entry of data.stacks) {
        // Drop entries missing any required field (or with non-string
        // values). A half-written / hand-edited record with an undefined
        // composeFile or cwd would otherwise reach the boot sweep and call
        // destroyComposeEnvironment with undefined args — which fails and,
        // because a failed teardown is retained for retry, would never
        // clear. Skipping it here is the safe default.
        if (
          !entry
          || typeof entry.projectId !== 'string' || !entry.projectId
          || !isValidComposeFile(entry.composeFile)
          || typeof entry.cwd !== 'string' || !entry.cwd
        ) {
          continue
        }
        this._stacks.set(entry.projectId, {
          projectId: entry.projectId,
          composeFile: entry.composeFile,
          cwd: entry.cwd,
          // Normalise a missing/invalid createdAt rather than persisting
          // `undefined` back out on the next write.
          createdAt: typeof entry.createdAt === 'string' && entry.createdAt
            ? entry.createdAt
            : new Date().toISOString(),
        })
      }
    } catch {
      // Corrupt / non-JSON state file — start empty rather than crash.
    }
  }
}

/**
 * Boot-time garbage collector. Tears down every persisted compose stack via
 * the backend's `destroyComposeEnvironment`, forgetting each one only after a
 * successful teardown so a transient docker-down failure is retried on the
 * next boot.
 *
 * @param {object} args
 * @param {ByokComposeStateStore} args.store   - The persistence store.
 * @param {object} args.backend                - Object with
 *   `destroyComposeEnvironment({ composeFile, composeProject, cwd })`.
 * @returns {Promise<{swept:number, failed:number}>}
 */
export async function sweepOrphanedComposeStacks({ store, backend } = {}) {
  const stacks = store.list()
  let swept = 0
  let failed = 0
  for (const stack of stacks) {
    try {
      await backend.destroyComposeEnvironment({
        composeFile: stack.composeFile,
        composeProject: stack.projectId,
        cwd: stack.cwd,
      })
      // Only forget after a clean teardown — a failure leaves the entry on
      // disk so the next boot retries.
      store.forget(stack.projectId)
      swept += 1
    } catch (err) {
      failed += 1
      // eslint-disable-next-line no-console
      console.warn(
        `[byok-compose-state] sweep of ${stack.projectId} failed (will retry next boot): ${err.message}`,
      )
    }
  }
  return { swept, failed }
}
