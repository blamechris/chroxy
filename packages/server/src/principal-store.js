/**
 * The agent-principal credential store (docs/security/agent-principals.md §3).
 *
 * A principal is a scoped, revocable, labelled credential for a supervisor agent. The
 * daemon keeps ONLY a SHA-256 hash of each token plus the grant's metadata, in a 0600
 * file in the config dir, read through `readTrustedSecretFile` (O_NOFOLLOW open, fstat
 * of the same fd, exact-mode and owner check). The CLI never edits this file: the
 * daemon process is the only writer, so daemon and CLI cannot race.
 *
 * FAIL CLOSED. A store that is not exactly 0600, not owned by the daemon's uid, a
 * symlink, not a regular file, oversized or corrupt invalidates EVERY principal, and
 * `health()` says why in words an operator can act on (`chroxy doctor` surfaces it). A
 * single malformed entry is dropped (it grants nothing) without taking the rest down;
 * entries sharing a live label are all dropped (a label must name exactly one grant).
 *
 * NO TOKEN CAN BE MINTED YET. Contract §12 lands the audit writer and kill switch (S11)
 * BEFORE the first mintable token, so `grant()` always refuses. This module contains no
 * token generator. `buildPrincipalEntry` is the pure validator a later grant will use;
 * it takes a hash, never a token. Tests insert entries through `_testOnlyInsertEntry`,
 * which exists only on a store constructed with `allowTestInsert: true`.
 *
 * TRUST BOUNDARY. Anyone who can write files as the daemon's uid can hand-write a valid
 * 0600 store and so create a principal. That is the same boundary as reading
 * `connection.json` for the primary token (contract section 2, the same-user limit); it is
 * not a mint path in this code, and nothing here defends against it.
 *
 * REVOKE ORDER (§3, §10.2): flip in memory first (fail closed: the credential is dead
 * the instant the call starts), then persist with the durable write, then report. A
 * failed persist leaves memory revoked and reports `durable: false`; a refresh from disk
 * never un-revokes an id the process has revoked.
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readTrustedSecretFile } from './trusted-file-read.js'
import { safeTokenCompare } from './token-compare.js'
import { writeDurableFile } from './durable-write.js'
import { configPath } from './config-dir.js'
import { createLogger } from './logger.js'
import { PRINCIPAL_TIER_ORDER } from './principal-policy.js'

const log = createLogger('principal-store')

/** `<config dir>/principals.json`, resolved per call so CHROXY_CONFIG_DIR is honored. */
export function principalStorePath() {
  return configPath('principals.json')
}

export const PRINCIPAL_STORE_VERSION = 1
export const PRINCIPAL_LABEL_PATTERN = /^[a-z0-9_-]{1,32}$/
export const DEFAULT_PRINCIPAL_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_PRINCIPAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** A store is a few KB; a bigger file is not ours. */
export const MAX_PRINCIPAL_STORE_BYTES = 256 * 1024
const MAX_PRINCIPALS = 256
const MAX_CONSTRAINT_ENTRIES = 64
const MAX_CONSTRAINT_LENGTH = 1024
const MAX_PRESENTED_TOKEN_LENGTH = 512
const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/
const PRINCIPAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** The one refusal text for `grant` until the brakes (S11) land. */
export const PRINCIPALS_NOT_ENABLED_MESSAGE = 'agent principals not yet enabled'

export class PrincipalGrantsDisabledError extends Error {
  constructor() {
    super(PRINCIPALS_NOT_ENABLED_MESSAGE)
    this.name = 'PrincipalGrantsDisabledError'
    this.code = 'PRINCIPALS_NOT_ENABLED'
  }
}

/** @param {string} token @returns {string} */
export function hashPrincipalToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function stringList(value) {
  if (!Array.isArray(value) || value.length > MAX_CONSTRAINT_ENTRIES) return null
  const out = []
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0 || v.length > MAX_CONSTRAINT_LENGTH) return null
    out.push(v)
  }
  return out
}

/**
 * Validate constraints. A grant must name at least one session id or cwd root; any
 * other shape grants nothing. Returns the cleaned object or null.
 */
function cleanConstraints(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const out = {}
  for (const key of ['sessionIds', 'cwdRoots', 'providers', 'models']) {
    if (value[key] === undefined) continue
    const list = stringList(value[key])
    if (list === null) return null
    out[key] = list
  }
  const named = (out.sessionIds?.length ?? 0) + (out.cwdRoots?.length ?? 0)
  return named > 0 ? out : null
}

/**
 * Validate one stored entry. Pure. Returns `{ entry }` or `{ reason }`.
 * Expiry is absolute and bounded: an entry that lives longer than the maximum TTL is
 * refused, never clamped.
 * @param {unknown} raw
 * @returns {{ entry: object } | { reason: string }}
 */
export function parsePrincipalEntry(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an object' }
  const { principalId, tokenHash, label, tier, scope, constraints, createdAt, expiresAt, revokedAt } = raw
  if (typeof principalId !== 'string' || !PRINCIPAL_ID_PATTERN.test(principalId)) return { reason: 'bad principalId' }
  if (typeof tokenHash !== 'string' || !TOKEN_HASH_PATTERN.test(tokenHash)) return { reason: 'bad tokenHash' }
  if (typeof label !== 'string' || !PRINCIPAL_LABEL_PATTERN.test(label)) return { reason: 'bad label' }
  // An unknown or malformed scope grants nothing: the entry is invalid.
  if (typeof scope !== 'string' || !PRINCIPAL_TIER_ORDER.includes(scope)) return { reason: 'bad scope' }
  if (tier !== scope) return { reason: 'tier does not match scope' }
  const cleaned = cleanConstraints(constraints)
  if (cleaned === null) return { reason: 'bad constraints' }
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return { reason: 'bad createdAt' }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt) return { reason: 'bad expiresAt' }
  if (expiresAt - createdAt > MAX_PRINCIPAL_TTL_MS) return { reason: 'expiresAt beyond the maximum TTL' }
  if (revokedAt !== null && revokedAt !== undefined && (!Number.isSafeInteger(revokedAt) || revokedAt <= 0)) {
    return { reason: 'bad revokedAt' }
  }
  return {
    entry: {
      principalId, tokenHash, label, tier, scope, constraints: cleaned, createdAt, expiresAt,
      revokedAt: revokedAt ?? null,
    },
  }
}

/**
 * Validate a grant request and build the entry a later `grant` will store. Pure: it
 * hashes a token it is GIVEN and never generates one. Refusals are returned, never
 * clamped: a TTL above the maximum is `TTL_TOO_LONG`.
 *
 * @param {{ label?: unknown, scope?: unknown, constraints?: unknown, ttlMs?: unknown }} req
 * @param {{ tokenHash: string, principalId: string, now: number }} ctx
 * @returns {{ ok: true, entry: object } | { ok: false, code: string, message: string }}
 */
export function buildPrincipalEntry(req, { tokenHash, principalId, now }) {
  const fail = (code, message) => ({ ok: false, code, message })
  if (typeof req?.label !== 'string' || !PRINCIPAL_LABEL_PATTERN.test(req.label)) {
    return fail('BAD_LABEL', 'label must match ^[a-z0-9_-]{1,32}$')
  }
  if (typeof req.scope !== 'string' || !PRINCIPAL_TIER_ORDER.includes(req.scope)) {
    return fail('BAD_SCOPE', `scope must be one of ${PRINCIPAL_TIER_ORDER.join(', ')}`)
  }
  const ttlMs = req.ttlMs === undefined ? DEFAULT_PRINCIPAL_TTL_MS : req.ttlMs
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) return fail('BAD_TTL', 'ttl must be a positive duration')
  if (ttlMs > MAX_PRINCIPAL_TTL_MS) return fail('TTL_TOO_LONG', 'ttl above 7 days is refused, not clamped')
  const constraints = cleanConstraints(req.constraints)
  if (constraints === null) return fail('BAD_CONSTRAINTS', 'a grant must name at least one session id or cwd root')
  const parsed = parsePrincipalEntry({
    principalId, tokenHash, label: req.label, tier: req.scope, scope: req.scope, constraints,
    createdAt: now, expiresAt: now + ttlMs, revokedAt: null,
  })
  if ('reason' in parsed) return fail('BAD_ENTRY', parsed.reason)
  return { ok: true, entry: parsed.entry }
}

function describeRefusal(code, mode) {
  const found = typeof mode === 'number' ? ` (mode is 0${mode.toString(8)})` : ''
  switch (code) {
    case 'EMODE': return `the principal store is not mode 0600${found}: re-mode it to 0600 under the daemon's uid`
    case 'EOWNER': return "the principal store is not owned by the daemon's uid: re-own it to the daemon's uid and mode 0600"
    case 'ELOOP': return 'the principal store is a symlink: replace it with a regular 0600 file owned by the daemon'
    case 'ENOTFILE': return 'the principal store is not a regular file'
    case 'ETOOBIG': return 'the principal store is larger than its size cap'
    default: return `the principal store could not be read safely (${code})`
  }
}

/**
 * @typedef {object} PrincipalSummary
 * @property {string} principalId
 * @property {string} label
 * @property {string} tier
 * @property {string} scope
 * @property {object} constraints
 * @property {number} expiresAt
 */

export class PrincipalStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.path]  defaults to `<config dir>/principals.json`, resolved per call
   * @param {() => number} [opts.now]
   * @param {(path: string, data: string) => { durable: boolean, unconfirmed: string|null }} [opts.writeDurable]
   * @param {boolean} [opts.allowTestInsert]  tests only; production never sets it
   * @param {(a: string, b: string) => boolean} [opts.compare]  the hash comparison; defaults to
   *   `safeTokenCompare`. Injectable only so a test can prove it runs once per stored entry.
   * @param {Function} [opts.readSecret]  defaults to `readTrustedSecretFile`; injectable so a test can make the read throw
   */
  constructor({ path, now = Date.now, writeDurable = writeDurableFile, allowTestInsert = false, compare = safeTokenCompare, readSecret = readTrustedSecretFile } = {}) {
    this._pathOpt = path ?? null
    this._now = now
    this._writeDurable = writeDurable
    this._compare = compare
    this._readSecret = readSecret
    this._allowTestInsert = allowTestInsert === true
    /** @type {Map<string, object>} */
    this._entries = new Map()
    this._invalidRaw = []
    /** ids this process has revoked: a refresh from disk never un-revokes one */
    this._revokedInMemory = new Map()
    this._health = { ok: false, status: 'unloaded', code: 'UNLOADED', reason: 'the principal store has not been read yet' }
  }

  get path() { return this._pathOpt ?? principalStorePath() }

  now() { return this._now() }

  /** Doctor-readable state: `{ ok, status: 'ok'|'absent'|'invalid', code, reason }`. */
  health() { return { ...this._health } }

  /**
   * Re-read the store from disk. Fail closed: any refusal or corruption empties the
   * live set. Cheap (a few KB); called at every `auth`, not per frame.
   * @returns {{ ok: boolean, status: string, code: string|null, reason: string|null }}
   */
  refresh() {
    let read
    try {
      read = this._readSecret(this.path, { mode: 0o600, checkOwner: true, maxSize: MAX_PRINCIPAL_STORE_BYTES })
    } catch (err) {
      // The read itself can throw after the checks passed (EIO from readFileSync(fd)). A
      // store that cannot be read is not a store that is still trusted: nothing stays live.
      // `_revokedInMemory` is untouched, so a revoke made in this process survives.
      return this._setHealth({ ok: false, status: 'invalid', code: err?.code || 'EREAD', reason: `the principal store could not be read (${err?.code || 'error'}): every principal is refused until it can be` }, [], [])
    }
    if (read.status === 'absent') return this._setHealth({ ok: true, status: 'absent', code: null, reason: null }, [], [])
    if (read.status === 'refused') {
      return this._setHealth({ ok: false, status: 'invalid', code: read.code, reason: describeRefusal(read.code, read.mode) }, [], [])
    }
    let doc
    try {
      doc = JSON.parse(read.content)
    } catch {
      return this._setHealth({ ok: false, status: 'invalid', code: 'ECORRUPT', reason: 'the principal store is not valid JSON: restore it or delete it (deleting revokes every principal)' }, [], [])
    }
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== PRINCIPAL_STORE_VERSION ||
        !Array.isArray(doc.principals) || doc.principals.length > MAX_PRINCIPALS) {
      return this._setHealth({ ok: false, status: 'invalid', code: 'ECORRUPT', reason: 'the principal store has an unrecognised shape: restore it or delete it (deleting revokes every principal)' }, [], [])
    }
    // An identity named by two records is ambiguous, whatever else is wrong with either:
    // a malformed copy (an unknown scope, say) may be the revoked one. Checked on the RAW
    // records BEFORE any is discarded as malformed.
    const seenIds = new Set()
    for (const raw of doc.principals) {
      const id = raw !== null && typeof raw === 'object' ? raw.principalId : undefined
      if (typeof id !== 'string' || !PRINCIPAL_ID_PATTERN.test(id)) continue
      if (seenIds.has(id)) {
        return this._setHealth({ ok: false, status: 'invalid', code: 'ECORRUPT', reason: 'the principal store holds two records with one principalId: restore it or delete it (deleting revokes every principal)' }, [], [])
      }
      seenIds.add(id)
    }
    const entries = []
    const invalid = []
    const ids = new Set()
    for (const raw of doc.principals) {
      const parsed = parsePrincipalEntry(raw)
      if ('reason' in parsed) {
        invalid.push(raw)
        continue
      }
      // A principalId names exactly one grant. Two records with one id (a live one and a
      // revoked copy, in either order) cannot be told apart safely: the whole store is
      // corrupt and every principal is refused.
      if (ids.has(parsed.entry.principalId)) {
        return this._setHealth({ ok: false, status: 'invalid', code: 'ECORRUPT', reason: 'the principal store holds two records with one principalId: restore it or delete it (deleting revokes every principal)' }, [], [])
      }
      ids.add(parsed.entry.principalId)
      entries.push(parsed.entry)
    }
    // A label names exactly one live grant: every entry of a duplicated live label is dropped.
    const liveByLabel = new Map()
    for (const e of entries) {
      if (e.revokedAt === null) liveByLabel.set(e.label, (liveByLabel.get(e.label) ?? 0) + 1)
    }
    const kept = entries.filter((e) => {
      if (e.revokedAt === null && liveByLabel.get(e.label) > 1) { invalid.push(e); return false }
      return true
    })
    return this._setHealth({ ok: true, status: 'ok', code: null, reason: null }, kept, invalid)
  }

  _setHealth(health, entries, invalidRaw) {
    this._health = health
    this._entries = new Map(entries.map((e) => [e.principalId, e]))
    this._invalidRaw = invalidRaw
    if (invalidRaw.length > 0) log.warn(`${invalidRaw.length} principal store entr${invalidRaw.length === 1 ? 'y was' : 'ies were'} ignored (invalid or duplicate label)`)
    if (!health.ok) log.error(`Principal store invalid, every principal is refused: ${health.reason}`)
    return this.health()
  }

  _revokedAt(entry) {
    return this._revokedInMemory.get(entry.principalId) ?? entry.revokedAt
  }

  /** @returns {'live'|'revoked'|'expired'|'invalid'} why a principal is or is not usable now */
  state(principalId) {
    if (!this._health.ok) return 'invalid'
    const e = this._entries.get(principalId)
    if (!e) return 'invalid'
    if (this._revokedAt(e) !== null) return 'revoked'
    if (!(this._now() < e.expiresAt)) return 'expired'
    return 'live'
  }

  /** In-memory liveness: the per-frame re-check. */
  isLive(principalId) { return this.state(principalId) === 'live' }

  _summary(e) {
    return {
      principalId: e.principalId, label: e.label, tier: e.tier, scope: e.scope,
      constraints: JSON.parse(JSON.stringify(e.constraints)), expiresAt: e.expiresAt,
    }
  }

  /**
   * Resolve a presented token to a live principal, or null.
   *
   * The presented token's hash is compared with EVERY stored hash through
   * `safeTokenCompare`, with no early exit, so timing does not reveal which entry (or
   * whether any) matched. The token is never logged.
   * @param {unknown} token
   * @param {{ reload?: boolean }} [opts]
   * @returns {PrincipalSummary|null}
   */
  validate(token, { reload = true } = {}) {
    if (reload) this.refresh()
    const presented = typeof token === 'string' && token.length > 0 && token.length <= MAX_PRESENTED_TOKEN_LENGTH
      ? hashPrincipalToken(token)
      : hashPrincipalToken('')
    let matched = null
    for (const e of this._entries.values()) {
      if (this._compare(presented, e.tokenHash) && matched === null) matched = e
    }
    if (matched === null || typeof token !== 'string' || token.length === 0 || token.length > MAX_PRESENTED_TOKEN_LENGTH) return null
    return this.state(matched.principalId) === 'live' ? this._summary(matched) : null
  }

  /**
   * Every grant, with its state and never its hash. Reads the store first.
   * @returns {{ health: object, principals: object[] }}
   */
  list() {
    this.refresh()
    const principals = [...this._entries.values()].map((e) => ({
      principalId: e.principalId, label: e.label, tier: e.tier, scope: e.scope, constraints: e.constraints,
      createdAt: e.createdAt, expiresAt: e.expiresAt, revokedAt: this._revokedAt(e),
      state: this.state(e.principalId),
    }))
    return { health: this.health(), principals }
  }

  /** The principals that are currently live (no reload). */
  liveSummaries() {
    return [...this._entries.keys()].filter((id) => this.isLive(id)).map((id) => this._summary(this._entries.get(id)))
  }

  /**
   * `grant` refuses until the audit writer and kill switch land (contract §12). There
   * is no token generator in this module and no code behind this refusal.
   */
  grant() {
    throw new PrincipalGrantsDisabledError()
  }

  /**
   * Revoke one grant by `principalId` or by the label of a live grant.
   * Memory first, then the durable write, then the verdict.
   * @param {{ principalId?: string, label?: string }} selector
   * @returns {{ found: false } | { found: true, principalId: string, alreadyRevoked: boolean, durable: boolean, persistError: string|null }}
   */
  revoke(selector) {
    this.refresh()
    let target = null
    if (typeof selector?.principalId === 'string') target = this._entries.get(selector.principalId) ?? null
    else if (typeof selector?.label === 'string') {
      for (const e of this._entries.values()) {
        if (e.label === selector.label && this._revokedAt(e) === null) { target = e; break }
      }
    }
    if (target === null) return { found: false }
    const alreadyRevoked = this._revokedAt(target) !== null
    if (!alreadyRevoked) this._revokedInMemory.set(target.principalId, this._now())
    // Persist even when already revoked in memory: an earlier persist may have failed.
    const outcome = this._persist()
    return { found: true, principalId: target.principalId, alreadyRevoked, durable: outcome.durable, persistError: outcome.error }
  }

  _persist() {
    const principals = [
      ...[...this._entries.values()].map((e) => ({ ...e, revokedAt: this._revokedAt(e) })),
      ...this._invalidRaw,
    ]
    const text = JSON.stringify({ version: PRINCIPAL_STORE_VERSION, principals }, null, 2) + '\n'
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const r = this._writeDurable(this.path, text)
      if (!r.durable) log.error(`Principal store written but not confirmed durable (${r.unconfirmed})`)
      return { durable: r.durable, error: r.durable ? null : (r.unconfirmed ?? 'unconfirmed') }
    } catch (err) {
      log.error(`Principal store write failed: ${err?.code || err?.message || 'error'}`)
      return { durable: false, error: err?.code || 'WRITE_FAILED' }
    }
  }

  /**
   * TEST ONLY. Insert an already-built entry and persist it. Refuses unless the store
   * was constructed with `allowTestInsert: true`, which no production path does.
   * @param {object} entry  the result of `buildPrincipalEntry(...).entry`
   */
  _testOnlyInsertEntry(entry) {
    if (!this._allowTestInsert) throw new Error('principal insert is test-only')
    const parsed = parsePrincipalEntry(entry)
    if ('reason' in parsed) throw new Error(`invalid principal entry: ${parsed.reason}`)
    this.refresh()
    if (this._entries.has(parsed.entry.principalId)) throw new Error('duplicate principalId')
    if (parsed.entry.revokedAt === null) {
      for (const e of this._entries.values()) {
        if (e.label === parsed.entry.label && this._revokedAt(e) === null) throw new Error('duplicate live label')
      }
    }
    this._entries.set(parsed.entry.principalId, parsed.entry)
    this._health = { ok: true, status: 'ok', code: null, reason: null }
    const outcome = this._persist()
    if (outcome.error) throw new Error(`principal store write failed (${outcome.error})`)
  }
}

/** @param {ConstructorParameters<typeof PrincipalStore>[0]} [opts] */
export function createPrincipalStore(opts) {
  const store = new PrincipalStore(opts)
  store.refresh()
  return store
}
