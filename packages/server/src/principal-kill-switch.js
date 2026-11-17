/**
 * The persistent agent-principal kill switch (docs/security/agent-principals.md 10.2).
 *
 * State: `{ all, labels }`. `all` disables every principal; `labels` disables the
 * principals carrying one of those operator labels. Re-enabling is an explicit operator
 * action (`enable`), never automatic.
 *
 * ORDER (shared with revoke): flip MEMORY first, then persist durably, then report.
 * `disable` makes the switch effective in memory before it touches the disk, so a failed
 * or slow persist can never leave principals live. A failed persist keeps memory
 * disabled and reports `durable: false`. Residual: a restart before a successful persist
 * can revive the principals, so the owner should disable again once the file is writable.
 *
 * THE FILE. `<config dir>/principals-disabled.json`, `{ version, all, labels, updatedAt }`,
 * written ONLY by the daemon, through `writeDurableFile` (temp file, fsync, rename, fsync
 * of the directory; mode 0600). Read through `readTrustedSecretFile` (O_NOFOLLOW, fstat of
 * the same fd, exact mode 0600, owner check, size cap).
 *
 * BOOT READS FAIL CLOSED. An ABSENT file means the switch was never thrown: enabled. A file
 * that is unreadable, corrupt, a symlink, not 0600, not ours, oversized or of an unknown
 * shape means DISABLED FOR ALL, with `health()` saying why. Enabling from that state is
 * the operator's explicit `enable --all`, which rewrites a good file.
 *
 * The permissive direction (`enable`) flips memory only after the file is published, so a
 * failed write can never leave the daemon enabled while the file says disabled.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readTrustedSecretFile } from './trusted-file-read.js'
import { writeDurableFile } from './durable-write.js'
import { configPath } from './config-dir.js'
import { createLogger } from './logger.js'
import { PRINCIPAL_LABEL_PATTERN } from './principal-label.js'

const log = createLogger('principal-kill-switch')

export const KILL_SWITCH_VERSION = 1
export const MAX_KILL_SWITCH_BYTES = 16 * 1024
const MAX_LABELS = 256

/** `<config dir>/principals-disabled.json`, resolved per call so CHROXY_CONFIG_DIR is honored. */
export function killSwitchPath() {
  return configPath('principals-disabled.json')
}

function parseFlag(content) {
  let doc
  try { doc = JSON.parse(content) } catch { return { reason: 'the kill-switch file is not valid JSON' } }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== KILL_SWITCH_VERSION ||
      typeof doc.all !== 'boolean' || !Array.isArray(doc.labels) || doc.labels.length > MAX_LABELS ||
      !doc.labels.every((l) => typeof l === 'string' && PRINCIPAL_LABEL_PATTERN.test(l))) {
    return { reason: 'the kill-switch file has an unrecognised shape' }
  }
  return { all: doc.all, labels: [...new Set(doc.labels)] }
}

export class PrincipalKillSwitch {
  /**
   * @param {object} [opts]
   * @param {string} [opts.path]
   * @param {() => number} [opts.now]
   * @param {(path: string, data: string) => { durable: boolean, unconfirmed: string|null }} [opts.writeDurable]
   * @param {Function} [opts.readSecret]
   */
  constructor({ path, now = Date.now, writeDurable = writeDurableFile, readSecret = readTrustedSecretFile } = {}) {
    this._pathOpt = path ?? null
    this._now = now
    this._writeDurable = writeDurable
    this._readSecret = readSecret
    this._all = false
    this._labels = new Set()
    this._health = { ok: true, status: 'unloaded', reason: null }
    this.load()
  }

  get path() { return this._pathOpt ?? killSwitchPath() }

  /** Boot read. Fail closed; see the header. Replaces the in-memory state. */
  load() {
    let read
    try {
      read = this._readSecret(this.path, { mode: 0o600, checkOwner: true, maxSize: MAX_KILL_SWITCH_BYTES })
    } catch (err) {
      return this._failClosed(`the kill-switch file could not be read (${err?.code || 'error'})`)
    }
    if (read.status === 'absent') {
      this._all = false
      this._labels = new Set()
      this._health = { ok: true, status: 'absent', reason: null }
      return this.health()
    }
    if (read.status === 'refused') return this._failClosed(`the kill-switch file is not trusted (${read.code})`)
    const parsed = parseFlag(read.content)
    if ('reason' in parsed) return this._failClosed(parsed.reason)
    this._all = parsed.all
    this._labels = new Set(parsed.labels)
    this._health = { ok: true, status: 'ok', reason: null }
    return this.health()
  }

  _failClosed(reason) {
    this._all = true
    this._labels = new Set()
    this._health = { ok: false, status: 'invalid', reason: `${reason}: every agent principal is disabled until an operator runs \`chroxy agent enable --all\`` }
    log.error(`Kill-switch file unusable, every principal is disabled: ${reason}`)
    return this.health()
  }

  health() { return { ...this._health } }

  /** Memory only: the per-frame check. */
  isDisabled(label) {
    return this._all || (typeof label === 'string' && this._labels.has(label))
  }

  /** @returns {{ all: boolean, labels: string[] }} */
  snapshot() { return { all: this._all, labels: [...this._labels].sort() } }

  _persist(state) {
    const text = JSON.stringify({ version: KILL_SWITCH_VERSION, all: state.all, labels: state.labels, updatedAt: this._now() }, null, 2) + '\n'
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const r = this._writeDurable(this.path, text)
      if (!r.durable) log.error(`Kill-switch file written but not confirmed durable (${r.unconfirmed})`)
      return { published: true, durable: r.durable, error: r.durable ? null : (r.unconfirmed ?? 'unconfirmed') }
    } catch (err) {
      log.error(`Kill-switch file write failed: ${err?.code || err?.message || 'error'}`)
      return { published: false, durable: false, error: err?.code || 'WRITE_FAILED' }
    }
  }

  /**
   * Disable every principal (`{ all: true }`) or one label. MEMORY FIRST: the switch is
   * effective before the first byte is written, and stays effective if the write fails.
   * @param {{ all?: true, label?: string }} selector
   * @returns {{ ok: true, durable: boolean, persistError: string|null, state: { all: boolean, labels: string[] } } | { ok: false, code: string }}
   */
  disable(selector) {
    if (selector?.all === true) this._all = true
    else if (typeof selector?.label === 'string' && PRINCIPAL_LABEL_PATTERN.test(selector.label)) this._labels.add(selector.label)
    else return { ok: false, code: 'BAD_REQUEST' }
    const state = this.snapshot()
    const outcome = this._persist(state)
    return { ok: true, durable: outcome.durable, persistError: outcome.error, state }
  }

  /**
   * Re-enable every principal or one label: explicit, never automatic. The permissive
   * direction, so the file is published FIRST and memory flips only if the write did not
   * throw: a failed write leaves the daemon disabled, as the file still says.
   * @param {{ all?: true, label?: string }} selector
   * @returns {{ ok: true, durable: boolean, persistError: string|null, state: object } | { ok: false, code: string, state?: object }}
   */
  enable(selector) {
    let all = this._all
    const labels = new Set(this._labels)
    if (selector?.all === true) { all = false; labels.clear() }
    else if (typeof selector?.label === 'string' && PRINCIPAL_LABEL_PATTERN.test(selector.label)) {
      // A label cannot be re-enabled while everything is disabled: that is `enable --all`.
      if (this._all) return { ok: false, code: 'ALL_DISABLED', state: this.snapshot() }
      labels.delete(selector.label)
    } else return { ok: false, code: 'BAD_REQUEST' }
    const next = { all, labels: [...labels].sort() }
    const outcome = this._persist(next)
    if (!outcome.published) return { ok: false, code: 'PERSIST_FAILED', state: this.snapshot() }
    this._all = all
    this._labels = labels
    this._health = { ok: true, status: 'ok', reason: null }
    return { ok: true, durable: outcome.durable, persistError: outcome.error, state: this.snapshot() }
  }
}

export function createPrincipalKillSwitch(opts) { return new PrincipalKillSwitch(opts) }
