/**
 * Project-scoped incrementing session names ("chroxy 7") — the durable allocator.
 *
 * NOT WIRED INTO ANYTHING (slice N1). `SessionManager.createSession` is
 * synchronous, so this module is synchronous end to end.
 *
 * ## No lock. Compare-and-swap on generations.
 *
 * State lives in numbered generations, each with a primary and a mirror copy:
 *
 *   <dir>/session-names.g<12-digit gen>.json          (primary)
 *   <dir>/session-names.g<12-digit gen>.mirror.json   (mirror)
 *
 * Each file is `{ version: 1, gen, body, sha256 }`; `sha256` covers a canonical
 * (sorted-key) serialization of `{ version, gen, body }`. Nothing else in the
 * directory is ever parsed.
 *
 * A writer OWNS generation g+1 only if it creates BOTH names itself:
 *   1. write the full text (every byte, short writes looped) to two unique temp
 *      files (`session-names.tmp.<pid>.<token>.a|b`, outside the generation
 *      pattern) and fsync each;
 *   2. `linkSync(tmpA, primary)` then `linkSync(tmpB, mirror)` — each an atomic
 *      create-if-absent. EEXIST on EITHER means another writer owns g+1: unlink
 *      whichever of the two names THIS writer created, reload, retry. (A rename
 *      would overwrite and let a stale writer reclaim a generation whose other
 *      copy was lost.)
 *   3. fsync the directory once, unlink the temps;
 *   4. re-list the directory: if a generation GREATER than g+1 exists, this
 *      writer's view was stale (the store moved on and pruned g+1 — an ABA).
 *      Unlink our two names and retry; never issue;
 *   5. issue the number only when both links succeeded and the directory fsync
 *      was confirmed. Otherwise the number may already be persisted as `next`:
 *      it becomes a gap, never a reuse.
 * Contention is bounded (`maxAttempts`, default 8) and returns `contended`.
 * No sleeps, no lock file, no wall clock in mutual exclusion. A filesystem
 * without hard links returns `unsupported_fs` (non-closing, nothing issued).
 * Every outcome after a load (issued, lost, failed) prunes: generations below
 * top-2 and temp files older than 10 minutes are removed; the top three
 * generations are never touched.
 *
 * Two consequences of the two-link publish, both on the safe side:
 *   - between a writer's two links a concurrent reader can see two valid copies
 *     with different sha256 and fail closed `inconsistent` for that one call;
 *   - a crash inside that window, in the lost-copy case, leaves a permanent
 *     `inconsistent`: no duplicate is possible, and operator recovery applies.
 *
 * ## Load
 *
 * Every call re-reads the directory (no cache). The highest generation that has
 * any file is the state:
 *   - no naming files at all           -> fresh (gen 0)
 *   - either copy valid                -> use it (primary preferred)
 *   - both valid, different sha256     -> fail closed: 'inconsistent'
 *   - at least one copy present but bad, none valid -> fail closed: 'evidence_lost'
 *   - both copies ENOENT after listing (pruned under us) -> re-list, retry
 *   - any other read error (EIO, EMFILE, EACCES) -> 'io_error' (non-closing)
 * An older generation is NEVER a fallback. Failing closed returns
 * `{ ok: false, reason }` from allocate and bind and WRITES NOTHING, so corrupt
 * evidence keeps the allocator closed across restarts (callers use their legacy
 * names). Naming files are opened O_RDONLY|O_NONBLOCK|O_NOFOLLOW, fstat'd, and
 * must be regular files of at most MAX_STORE_BYTES, so a FIFO planted at a
 * naming path cannot block the daemon.
 *
 * ## Guarantee (narrowed on purpose)
 *
 * A number issued for a key is never issued again for that key while at least
 * one durable copy of the generation that recorded it, or of any later
 * generation, survives intact. If both copies of the highest generation are
 * invalid, numbered allocation fails closed (callers use legacy names) and the
 * allocator writes nothing until an operator removes the naming files. If all
 * naming files are deleted, that is indistinguishable from first use: numbering
 * restarts above the highest number in LIVE session names, and numbers that
 * belonged only to deleted sessions or unused allocations may be issued again —
 * this case is outside the guarantee.
 *
 * On win32 the guarantee holds across process crashes and restarts; durability
 * of directory entries against POWER LOSS is not confirmed (the directory fsync
 * is skipped there, and `writeFileRestricted` assumes rename is write-through).
 *
 * ## Operator recovery from a fail-closed state
 *
 * Stop the daemon and remove every `session-names.*` file in the config dir,
 * then start it again. Accepted cost: numbers may repeat those of sessions that
 * no longer exist. There is no lock and no stale-lock state to clean up.
 *
 * ## Other behaviour
 *
 * - Live floor: n = max(stored next, highest live "<key> <n>" + 1). Live
 *   numbers that are not safe integers or exceed 1,000,000 are ignored, so a
 *   user-typed "chroxy 99999999999" cannot exhaust a project.
 * - Idempotency records (<= 512, <= 24 h by `now`, ordered by a persisted
 *   monotonic `seq`, never by wall clock) store key, canonical root, number and
 *   bound session. A retry of an unbound key returns the same number but ONLY
 *   after a new generation carrying it was published and confirmed. A key reused
 *   for a different project or root is refused, never remapped. Expiry (24 h) is
 *   applied BEFORE lookup, so a retry of an expired key is a new key; a clock
 *   that moves backwards never drops a fresh record.
 * - The serialized size is checked BEFORE publishing against MAX_STORE_BYTES.
 *   Over budget: idempotency records are evicted oldest-seq first (never the
 *   current one); still over -> 'store_full' (non-closing, nothing written).
 * - Numbers stop at MAX_SAFE_INTEGER - 1, and generations at 999999999999
 *   ('exhausted', nothing written).
 * - `body.projects` is deliberately unbounded: after roughly 3,000 distinct
 *   projects, new projects get `store_full` while existing ones keep allocating.
 * - A candidate name is checked against every live name; collisions are skipped
 *   (at most 64) and then fail with `live_collision` (non-closing).
 * - Nothing here throws for I/O or corruption problems; those return
 *   `{ ok: false, reason }`. Only bad arguments throw (programming errors).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync,
  readSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { canonicalProjectForCwd } from '@chroxy/protocol/project'
import { configDir } from './config-dir.js'

export const MAX_STORE_BYTES = 1024 * 1024

const VERSION = 1
const MAX_LABEL_CODE_POINTS = 64
const MAX_ROOT_CODE_POINTS = 512
const MAX_SESSION_ID_LEN = 128
const MAX_IDEM_KEY_LEN = 256
const MAX_KEYS = 512
const KEY_TTL_MS = 24 * 60 * 60 * 1000
const MAX_LIVE_NUMBER = 1_000_000
const DEFAULT_MAX_ATTEMPTS = 8
const KEEP_GENERATIONS = 3
const TMP_PREFIX = 'session-names.tmp.'
const TMP_STALE_MS = 10 * 60 * 1000
const FILE_RE = /^session-names\.g(\d{12})(\.mirror)?\.json$/
const MAX_GEN = 999_999_999_999
const MAX_LIVE_SKIPS = 64

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

// Once per process per (dir, reason) — a closed allocator is polled on every create.
const loggedFailClosed = new Set()
const loggedRefusals = new Set()

const genName = (gen, mirror) => `session-names.g${String(gen).padStart(12, '0')}${mirror ? '.mirror' : ''}.json`

/** Read a naming file without ever blocking; non-regular or oversized files are refused. */
function defaultReadFile(path, maxBytes = MAX_STORE_BYTES) {
  const fd = openSync(path, fsConstants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > maxBytes) {
      const err = new Error('naming file is not a regular file or is oversized')
      err.code = 'ECHROXY_BADFILE'
      throw err
    }
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    return buf.subarray(0, off).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** fsync a directory so a new entry survives power loss. Not possible on win32. */
function defaultSyncDir(dir) {
  if (process.platform === 'win32') return
  const fd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Sorted-key JSON, so the digest does not depend on property order. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(version, gen, body) {
  return createHash('sha256').update(canonicalJson({ version, gen, body })).digest('hex')
}

/** Label normalization: NFC, whitespace collapsed, control chars stripped, 64 code-point cap. */
export function normalizeLabel(raw) {
  if (typeof raw !== 'string') return ''
  let s = raw.normalize('NFC').replace(/\s+/gu, ' ')
  s = s.replace(/\p{Cc}/gu, '')
  s = Array.from(s.trim()).slice(0, MAX_LABEL_CODE_POINTS).join('')
  return s.trim().normalize('NFC')
}

export function keyForLabel(label) {
  return label.normalize('NFC').toLowerCase()
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const isInt = (v) => Number.isSafeInteger(v) && v >= 1
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function validBody(body) {
  if (!isObj(body) || !isObj(body.projects) || !isObj(body.keys)) return false
  if (!Number.isSafeInteger(body.seq) || body.seq < 0) return false
  for (const [k, p] of Object.entries(body.projects)) {
    if (k.length > MAX_LABEL_CODE_POINTS * 2) return false
    if (!isObj(p) || typeof p.label !== 'string' || typeof p.root !== 'string' || !isInt(p.next)) return false
  }
  for (const [id, e] of Object.entries(body.keys)) {
    if (id.length > MAX_IDEM_KEY_LEN) return false
    if (!isObj(e) || typeof e.key !== 'string' || !/^[0-9a-f]{64}$/.test(e.rootId) || !isInt(e.n)) return false
    if (!(e.sessionId === null || (typeof e.sessionId === 'string' && e.sessionId.length <= MAX_SESSION_ID_LEN))) return false
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || !Number.isSafeInteger(e.seq) || e.seq < 0) return false
  }
  return true
}

/** Reasons a naming path is "present but not usable" (as opposed to a transient I/O error). */
const BAD_FILE_CODES = new Set(['ECHROXY_BADFILE', 'ELOOP', 'EISDIR'])

/** @returns {{state:'absent'}|{state:'error'}|{state:'invalid'}|{state:'valid',gen:number,sha256:string,body:object}} */
function readCopy(path, gen, readFile) {
  let text
  try {
    text = readFile(path, MAX_STORE_BYTES)
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent' }
    return BAD_FILE_CODES.has(err?.code) ? { state: 'invalid' } : { state: 'error' }
  }
  try {
    const doc = JSON.parse(text)
    if (!isObj(doc) || doc.version !== VERSION || doc.gen !== gen || typeof doc.sha256 !== 'string') return { state: 'invalid' }
    if (!validBody(doc.body)) return { state: 'invalid' }
    if (digest(doc.version, doc.gen, doc.body) !== doc.sha256) return { state: 'invalid' }
    return { state: 'valid', gen: doc.gen, sha256: doc.sha256, body: doc.body }
  } catch {
    return { state: 'invalid' }
  }
}

const emptyBody = () => ({ projects: {}, keys: {}, seq: 0 })
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
// Plain `obj[k] = v` with k === '__proto__' would rewrite the prototype, not add a key.
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true })

/**
 * @param {object} opts
 * @param {string} [opts.dir]              defaults to the config dir (honours CHROXY_CONFIG_DIR)
 * @param {() => string[]} [opts.liveNames] names of sessions that exist right now
 * @param {() => number} [opts.now]        wall clock (idempotency TTL only)
 * @param {{warn?:Function,error?:Function,info?:Function}} [opts.log]
 * @param {number} [opts.maxAttempts]      bound on CAS retries
 * @param {object} [opts.deps]             test seams: readFile, readdir, linkSync, syncDir, writeSync,
 *                                         afterLoad, maxBytes
 */
export function createSessionNameAllocator({
  dir = configDir(),
  liveNames = () => [],
  now = Date.now,
  log = {},
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  deps = {},
} = {}) {
  const readFile = deps.readFile ?? defaultReadFile
  const link = deps.linkSync ?? linkSync
  const syncDir = deps.syncDir ?? defaultSyncDir
  const writeBytes = deps.writeSync ?? ((fd, buf, off, len) => writeSync(fd, buf, off, len))
  const listDir = deps.readdir ?? readdirSync
  const afterLoad = deps.afterLoad ?? null
  const maxBytes = deps.maxBytes ?? MAX_STORE_BYTES

  // A refused git config makes the project fall back to legacy names: say so once per root.
  const onRefuse = ({ reason, dir: where }) => {
    const k = `${where}\u0000${reason}`
    if (loggedRefusals.has(k)) return
    loggedRefusals.add(k)
    emit('warn', `session names: ${where} fell back to legacy naming (${reason}); its git config is outside the supported subset`, { reason, dir: where })
  }

  const emit = (level, msg, fields) => {
    try {
      log?.[level]?.(msg, fields)
    } catch { /* a broken logger must not break allocation */ }
  }

  const listGens = () => {
    const gens = new Map()
    for (const name of listDir(dir)) {
      const m = FILE_RE.exec(name)
      if (!m) continue
      const g = Number(m[1])
      if (!Number.isSafeInteger(g) || g < 1) continue
      const slot = gens.get(g) ?? { primary: false, mirror: false }
      if (m[2]) slot.mirror = true
      else slot.primary = true
      gens.set(g, slot)
    }
    return gens
  }

  // ---- evidence -------------------------------------------------------
  const load = () => {
    let gens
    try {
      gens = listGens()
    } catch (err) {
      if (err?.code === 'ENOENT') return { kind: 'ok', gen: 0, body: emptyBody() }
      return { kind: 'error', reason: 'io_error' }
    }
    if (gens.size === 0) return { kind: 'ok', gen: 0, body: emptyBody() }
    const top = Math.max(...gens.keys())
    const a = readCopy(join(dir, genName(top, false)), top, readFile)
    const b = readCopy(join(dir, genName(top, true)), top, readFile)
    // Both gone: the store advanced and pruned this generation after we listed. Not corruption.
    if (a.state === 'absent' && b.state === 'absent') return { kind: 'retry' }
    const valid = [a, b].filter((c) => c.state === 'valid')
    if (valid.length === 0) {
      if (a.state === 'error' || b.state === 'error') return { kind: 'error', reason: 'io_error' }
      return { kind: 'closed', reason: 'evidence_lost' }
    }
    if (valid.length === 2 && a.sha256 !== b.sha256) return { kind: 'closed', reason: 'inconsistent' }
    return { kind: 'ok', gen: top, body: structuredClone(valid[0].body) }
  }

  const failClosed = (reason) => {
    const k = `${dir}\u0000${reason}`
    if (!loggedFailClosed.has(k)) {
      loggedFailClosed.add(k)
      emit('error', `session-name allocator closed (${reason}); numbered names disabled until the session-names.* files in ${dir} are removed`, { reason })
    }
    return { ok: false, reason }
  }

  const serialize = (gen, body) => JSON.stringify({ version: VERSION, gen, body, sha256: digest(VERSION, gen, body) })

  /**
   * Fit the serialized store into the budget by evicting idempotency records, oldest seq first,
   * never `keep`. The excess is worked out from per-record sizes and ONE batch is evicted, then
   * the exact size is checked once (a re-serialization of a near-cap store costs tens of ms, so
   * it must not happen once per evicted record). Returns the final text, or null (store_full).
   */
  const fitBudget = (gen, body, keep) => {
    let text = serialize(gen, body)
    let size = Buffer.byteLength(text)
    if (size <= maxBytes) return text
    const victims = Object.entries(body.keys)
      .filter(([id]) => id !== keep)
      .sort((x, y) => x[1].seq - y[1].seq)
      .map(([id, e]) => ({ id, bytes: Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(e)) + 2 }))
    let next = 0
    while (size > maxBytes) {
      if (next >= victims.length) return null
      let excess = size - maxBytes
      while (excess > 0 && next < victims.length) {
        const v = victims[next++]
        delete body.keys[v.id]
        excess -= v.bytes
      }
      // `excess` is an estimate (separators, the digest is fixed width): confirm exactly, and
      // if it fell short the loop evicts a further batch.
      text = serialize(gen, body)
      size = Buffer.byteLength(text)
    }
    return text
  }

  const tryUnlink = (p) => {
    try { unlinkSync(p) } catch { /* ignore */ }
  }

  /** Write every byte (looping over short writes) to a fresh file and fsync it. */
  const writeTemp = (path, buf) => {
    let fd
    try {
      fd = openSync(path, 'wx', 0o600)
      let off = 0
      while (off < buf.length) {
        const n = writeBytes(fd, buf, off, buf.length - off)
        if (!Number.isInteger(n) || n <= 0 || n > buf.length - off) throw new Error('incomplete write')
        off += n
      }
      fsyncSync(fd)
      const done = fd
      fd = undefined
      closeSync(done)
    } catch (err) {
      if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
      tryUnlink(path)
      throw err
    }
  }

  /**
   * Publish `text` as generation `gen` by creating BOTH names. Returns 'won' | 'lost'
   * (another writer owns it, or a stale view) | 'unsupported' | 'error'.
   */
  const publish = (gen, text) => {
    const buf = Buffer.from(text)
    const primary = join(dir, genName(gen, false))
    const mirror = join(dir, genName(gen, true))
    const token = `${process.pid}.${randomBytes(6).toString('hex')}`
    const tmpA = join(dir, `${TMP_PREFIX}${token}.a`)
    const tmpB = join(dir, `${TMP_PREFIX}${token}.b`)
    const dropTemps = () => {
      tryUnlink(tmpA)
      tryUnlink(tmpB)
    }
    try {
      writeTemp(tmpA, buf)
      writeTemp(tmpB, buf)
    } catch (err) {
      emit('warn', `session-name temp write failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      dropTemps()
      return 'error'
    }
    const classify = (err) => {
      if (err?.code === 'EEXIST') return 'lost'
      if (err?.code === 'EPERM' || err?.code === 'ENOTSUP' || err?.code === 'EOPNOTSUPP' || err?.code === 'ENOSYS') return 'unsupported'
      emit('warn', `session-name publish failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      return 'error'
    }
    try {
      link(tmpA, primary)
    } catch (err) {
      dropTemps()
      return classify(err)
    }
    try {
      link(tmpB, mirror)
    } catch (err) {
      dropTemps()
      // EEXIST: another writer owns this generation's mirror, so our primary is a loser's debris
      // and is retracted. Any OTHER failure leaves the primary where it is: it may already have
      // been read (and built upon) by a concurrent writer, and retracting a visible generation
      // lets a stale writer re-create it and issue a number the later generation never saw. A
      // primary-only generation is valid under the load rules; the number becomes a gap.
      if (err?.code === 'EEXIST') tryUnlink(primary)
      return classify(err)
    }
    dropTemps()
    try {
      syncDir(dir)
    } catch (err) {
      emit('warn', `session-name directory fsync failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      return 'error'
    }
    // ABA guard: a newer generation means our view was stale and g+1 had been pruned.
    try {
      if (Math.max(...listGens().keys()) > gen) {
        tryUnlink(primary)
        tryUnlink(mirror)
        return 'lost'
      }
    } catch {
      // Both names exist and may be visible: never retract them. Unconfirmed; the number is a gap.
      return 'error'
    }
    return 'won'
  }

  /** Remove generations below top-2 and stale temp files. Never touches the top three. */
  const prune = () => {
    try {
      const names = readdirSync(dir)
      let top = 0
      for (const name of names) {
        const m = FILE_RE.exec(name)
        if (m) top = Math.max(top, Number(m[1]))
      }
      for (const name of names) {
        const m = FILE_RE.exec(name)
        if (m) {
          if (Number(m[1]) < top - (KEEP_GENERATIONS - 1)) tryUnlink(join(dir, name))
        } else if (name.startsWith(TMP_PREFIX)) {
          try {
            if (Date.now() - statSync(join(dir, name)).mtimeMs > TMP_STALE_MS) tryUnlink(join(dir, name))
          } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * The CAS loop. `step(state)` returns { done: result } to stop without writing, or
   * { body, keep, result } to publish body as the next generation and return result once durable.
   */
  const transact = (step) => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return { ok: false, reason: 'io_error' }
    }
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const state = load()
      if (state.kind === 'retry') continue
      if (state.kind === 'closed') return failClosed(state.reason)
      if (state.kind === 'error') return { ok: false, reason: state.reason }
      afterLoad?.({ gen: state.gen, attempt })
      const plan = step(state)
      if (plan.done) return plan.done
      const gen = state.gen + 1
      if (gen > MAX_GEN) return { ok: false, reason: 'exhausted' }
      const text = fitBudget(gen, plan.body, plan.keep)
      if (text === null) return { ok: false, reason: 'store_full' }
      const outcome = publish(gen, text)
      prune()
      if (outcome === 'lost') continue
      if (outcome === 'unsupported') return { ok: false, reason: 'unsupported_fs' }
      if (outcome === 'error') return { ok: false, reason: 'write_unconfirmed' }
      return plan.result
    }
    return { ok: false, reason: 'contended' }
  }

  /** TTL expiry (by wall clock, applied before lookup). Backwards clocks never expire anything. */
  const expire = (body) => {
    const t = now()
    for (const [id, e] of Object.entries(body.keys)) {
      if (t - e.at > KEY_TTL_MS) delete body.keys[id]
    }
  }

  /** Keep the newest MAX_KEYS records by seq, always retaining `keep`. */
  const capKeys = (body, keep) => {
    const ids = Object.keys(body.keys)
    if (ids.length <= MAX_KEYS) return
    const victims = ids.filter((id) => id !== keep).sort((x, y) => body.keys[x].seq - body.keys[y].seq)
    for (const id of victims.slice(0, ids.length - MAX_KEYS)) delete body.keys[id]
  }

  // ---- API ------------------------------------------------------------
  function allocate({ cwd, idempotencyKey } = {}) {
    if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('allocate: cwd must be a non-empty string')
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEM_KEY_LEN)) {
      throw new TypeError('allocate: idempotencyKey must be a non-empty string up to 256 chars')
    }
    let project
    try {
      project = canonicalProjectForCwd(cwd, undefined, onRefuse)
    } catch {
      project = null
    }
    if (!project) return { ok: false, reason: 'non_project' }
    const label = normalizeLabel(project.label)
    if (!label) return { ok: false, reason: 'non_project' }
    const key = keyForLabel(label)
    const root = Array.from(project.root).slice(0, MAX_ROOT_CODE_POINTS).join('')
    // Identity of the FULL realpath: two roots sharing a 512-code-point prefix must not collide.
    const rootId = createHash('sha256').update(project.root).digest('hex')

    try {
      return transact((state) => {
        let live
        try {
          live = Array.from(liveNames() ?? [], (n) => String(n).normalize('NFC').toLowerCase())
        } catch {
          return { done: { ok: false, reason: 'live_names_failed' } }
        }
        const liveSet = new Set(live)
        const re = new RegExp(`^${escapeRegExp(key)} (\\d+)$`)
        let floor = 0
        for (const name of live) {
          const m = re.exec(name)
          if (!m) continue
          const v = Number(m[1])
          if (!Number.isSafeInteger(v) || v > MAX_LIVE_NUMBER) continue // a typed-in huge number must not exhaust the project
          if (v > floor) floor = v
        }

        const body = state.body
        expire(body)
        const result = (n) => ({ ok: true, name: `${label} ${n}`, label, number: n, key })
        const entry = idempotencyKey !== undefined && own(body.keys, idempotencyKey) ? body.keys[idempotencyKey] : null
        if (entry && (entry.key !== key || entry.rootId !== rootId)) {
          return { done: { ok: false, reason: 'idempotency_key_conflict' } }
        }

        if (entry) {
          const held = liveSet.has(`${key} ${entry.n}`)
          if (entry.sessionId === null && !held) {
            // A retry of a create whose number was never bound: same number, but only after
            // a fresh generation carrying it is confirmed durable in both copies.
            return { body, keep: idempotencyKey, result: result(entry.n) }
          }
          emit('warn', `duplicate_create_request: idempotency key already ${entry.sessionId !== null ? 'bound to a session' : 'held by a live session'}; allocating a fresh number`, {
            reason: 'duplicate_create_request', key, n: entry.n,
          })
        }

        const stored = own(body.projects, key) ? body.projects[key].next : 1
        let n = Math.max(stored, floor + 1)
        // The floor ignores huge live numbers, but the name itself must still never duplicate a live one.
        let skips = 0
        while (liveSet.has(`${key} ${n}`)) {
          if (++skips > MAX_LIVE_SKIPS) return { done: { ok: false, reason: 'live_collision' } }
          n += 1
        }
        if (n >= Number.MAX_SAFE_INTEGER) return { done: { ok: false, reason: 'exhausted' } }
        setOwn(body.projects, key, { label, root, next: n + 1 })
        if (idempotencyKey !== undefined) {
          body.seq += 1
          setOwn(body.keys, idempotencyKey, { key, rootId, n, sessionId: null, at: now(), seq: body.seq })
          capKeys(body, idempotencyKey)
        }
        return { body, keep: idempotencyKey, result: result(n) }
      })
    } catch (err) {
      emit('error', `session-name allocator internal error: ${err?.message ?? err}`, { reason: 'internal_error' })
      return { ok: false, reason: 'internal_error' }
    }
  }

  function bind(idempotencyKey, sessionId, { number } = {}) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new TypeError('bind: idempotencyKey must be a non-empty string')
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LEN) {
      throw new TypeError('bind: sessionId must be a non-empty string up to 128 chars')
    }
    if (!isInt(number)) throw new TypeError('bind: { number } (the reserved number being bound) is required')
    try {
      return transact((state) => {
        const body = state.body
        expire(body)
        if (!own(body.keys, idempotencyKey)) return { done: { ok: false, reason: 'unknown_key' } }
        const entry = body.keys[idempotencyKey]
        // A delayed bind must not attach to a replacement reservation for the same key.
        if (entry.n !== number) return { done: { ok: false, reason: 'stale_reservation' } }
        if (entry.sessionId !== null && entry.sessionId !== sessionId) return { done: { ok: false, reason: 'already_bound' } }
        // Same-session retries publish too: `ok` is only ever reported behind a confirmed write.
        entry.sessionId = sessionId
        return { body, keep: idempotencyKey, result: { ok: true } }
      })
    } catch (err) {
      emit('error', `session-name allocator internal error: ${err?.message ?? err}`, { reason: 'internal_error' })
      return { ok: false, reason: 'internal_error' }
    }
  }

  return { allocate, bind }
}
