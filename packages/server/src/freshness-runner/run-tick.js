/**
 * One tick of the freshness reconciler over the three live sources, in
 * read-only mode: the ledger is written, nothing is delivered.
 *
 * Sources (each a read-only adapter, see docs/guides/freshness-reconciler.md):
 *   - the daemon's persisted session-state file,
 *   - the Claude Code session registry (activity evidence),
 *   - the Claude transcript tail reader.
 *
 * Defaults resolve the way the daemon resolves them: the state file under the
 * daemon's config dir (`CHROXY_CONFIG_DIR`), the registry and the transcript
 * projects under Claude's config dir (`CLAUDE_CONFIG_DIR`). Every path can be
 * overridden; tests always do.
 *
 * Read-only is structural, not a flag the code checks: this module imports no
 * network, child-process or credential module, the reconciler has no send
 * method, and the only directory written is the ledger's.
 */

import path from 'node:path'
import { coreConfig, createSessionRegistryAdapter, createStateFileAdapter, openReconciler, REGISTRY_SOURCE, STATE_FILE_SOURCE } from '../freshness/index.js'
import { CLAUDE_TRANSCRIPT_CAPS, CLAUDE_TRANSCRIPT_SOURCE, createClaudeTranscriptAdapter } from '../freshness-sources/index.js'
import { configDir, configPath } from '../config-dir.js'
import { claudeConfigDir, claudeProjectsDir } from '../utils/claude-config-dir.js'
import { readStateSchemaVersion, tickBuild } from './build-info.js'

export const DEFAULT_LEDGER_ID = 'chroxy-freshness'
export const DEFAULT_CADENCE_MINUTES = 30
export const SOURCES = Object.freeze([STATE_FILE_SOURCE, REGISTRY_SOURCE, CLAUDE_TRANSCRIPT_SOURCE])
export const MODES = Object.freeze(['read-only'])

/** The default location of each source, resolved as the daemon resolves it. */
export function defaultSourcePaths(env = process.env) {
  return {
    stateFile: configPath('session-state.json'),
    registryDir: path.join(claudeConfigDir(env), 'sessions'),
    projectsDir: claudeProjectsDir(env),
  }
}

function requireAbsolute(name, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`)
  return path.resolve(value)
}

/**
 * Run one tick of every source and return a summary. Throws before reading a
 * source when the ledger is held, corrupt or inside the daemon's state
 * directory; a source whose tick throws is reported in `failed` and the other
 * sources still run.
 *
 * @param {object} opts
 * @param {string} opts.ledgerDir        absolute; outside the daemon's state directory
 * @param {{commit:string|null,daemon_version:string,install:string}} opts.build  from `readBuild`
 * @param {string} [opts.stateFile] @param {string} [opts.registryDir] @param {string} [opts.projectsDir]
 * @param {string} [opts.ledgerId]
 * @param {number} [opts.cadenceMinutes]
 * @param {number} [opts.leaseMinutes]   must exceed the cadence (the core enforces it)
 * @param {string} [opts.mode]           only `read-only`
 * @param {number} [opts.now]            ms
 * @param {string[]} [opts.keepOutOf]    added to the daemon's config dir and the state file's directory
 * @param {object[]} [opts.adapters]     replaces the three live adapters; a test seam
 */
export function runTick({ ledgerDir, build, stateFile, registryDir, projectsDir, ledgerId = DEFAULT_LEDGER_ID, cadenceMinutes = DEFAULT_CADENCE_MINUTES, leaseMinutes, mode = 'read-only', now = Date.now(), keepOutOf = [], adapters: adaptersOverride }) {
  if (!MODES.includes(mode)) throw new TypeError(`mode must be one of ${MODES.join(', ')}; delivery is not part of this runner`)
  if (!Number.isFinite(cadenceMinutes) || cadenceMinutes <= 0) throw new TypeError('cadenceMinutes must be a positive number')
  if (leaseMinutes !== undefined && !(Number.isFinite(leaseMinutes) && leaseMinutes > 0)) throw new TypeError('leaseMinutes must be a positive number')
  const defaults = defaultSourcePaths()
  const paths = {
    stateFile: requireAbsolute('stateFile', stateFile ?? defaults.stateFile),
    registryDir: requireAbsolute('registryDir', registryDir ?? defaults.registryDir),
    projectsDir: requireAbsolute('projectsDir', projectsDir ?? defaults.projectsDir),
  }
  const ledger = requireAbsolute('ledgerDir', ledgerDir)
  const cadenceMs = cadenceMinutes * 60_000
  const config = coreConfig({ cadence_minutes: cadenceMinutes, sources: { [CLAUDE_TRANSCRIPT_SOURCE]: CLAUDE_TRANSCRIPT_CAPS } })
  const adapters = adaptersOverride ?? [
    createStateFileAdapter({ path: paths.stateFile }),
    createSessionRegistryAdapter({ dir: paths.registryDir }),
    createClaudeTranscriptAdapter({ projectsDir: paths.projectsDir }),
  ]
  const recorded = tickBuild(build, readStateSchemaVersion(paths.stateFile))
  const slotStart = Math.floor(now / cadenceMs) * cadenceMs
  const rec = openReconciler({
    dir: ledger,
    ledgerId,
    config,
    adapters,
    now,
    leaseMs: leaseMinutes === undefined ? undefined : leaseMinutes * 60_000,
    keepOutOf: [configDir(), path.dirname(paths.stateFile), ...keepOutOf],
  })
  const sources = []
  try {
    for (const source of SOURCES) {
      try {
        const res = rec.tick({ source, slotStart, now, build: recorded })
        const byFreshness = {}
        for (const r of res.reads) byFreshness[r.freshness] = (byFreshness[r.freshness] ?? 0) + 1
        sources.push({ source, ok: true, tick_id: res.tickId, skipped: res.skipped ?? null, sessions: res.reads.length, by_freshness: byFreshness })
      } catch (err) {
        sources.push({ source, ok: false, error: err?.name ?? 'Error' })
      }
    }
  } finally {
    rec.close()
  }
  return { mode, slot_start: slotStart, build: recorded, ledger: ledger, sources, failed: sources.filter((s) => !s.ok).map((s) => s.source) }
}
