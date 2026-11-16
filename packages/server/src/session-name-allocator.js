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
 *   <dir>/session-names.g<gen>.json          (primary)
 *   <dir>/session-names.g<gen>.mirror.json   (mirror)
 *
 * Each file is `{ version: 1, gen, body, sha256 }`; `sha256` covers a canonical
 * (sorted-key) serialization of `{ version, gen, body }`. Nothing else in the
 * directory is ever parsed.
 *
 * Publishing generation g+1 is the compare-and-swap:
 *   1. write the full text to a unique temp file (`session-names.tmp.<pid>.<token>`,
 *      which does not match the generation pattern) and fsync it;
 *   2. `linkSync(tmp, primary_g+1)` — an atomic create-if-absent. EEXIST means
 *      another writer won g+1: drop the temp, reload, retry;
 *   3. fsync the directory, unlink the temp;
 *   4. re-list the directory: if a generation GREATER than g+1 exists, this
 *      writer's view was stale (the store moved on and pruned g+1 — an ABA).
 *      Unlink our own primary and retry; never issue;
 *   5. write the mirror for g+1 with `writeDurableFile` (only the winner does);
 *   6. issue the number only when the primary publish and the mirror were both
 *      confirmed durable. Otherwise the number may already be persisted as
 *      `next`: it becomes a gap, never a reuse.
 * Contention is bounded (`maxAttempts`, default 8) and returns `contended`.
 * No sleeps, no lock file, no wall clock in mutual exclusion. A filesystem
 * without hard links returns `unsupported_fs` (non-closing, nothing issued).
 * After an issue the winner removes generations below g-2.
 *
 * ## Load
 *
 * Every call re-reads the directory (no cache). The highest generation that has
 * any file is the state:
 *   - no naming files at all           -> fresh (gen 0)
 *   - either copy valid                -> use it (primary preferred)
 *   - both valid, different sha256     -> fail closed: 'inconsistent'
 *   - files present, none valid        -> fail closed: 'evidence_lost'
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
 * - Numbers stop at MAX_SAFE_INTEGER - 1 ('exhausted').
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
import { writeDurableFile } from './durable-write.js'

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
const FILE_RE = /^session-names\.g(\d{1,15})(\.mirror)?\.json$/

const O_NONBLOCK = fsConstants.O_NONBLOCK ?? 0
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

// Once per process per (dir, reason) — a closed allocator is polled on every create.
const loggedFailClosed = new Set()

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
    if (!isObj(e) || typeof e.key !== 'string' || typeof e.root !== 'string' || !isInt(e.n)) return false
    if (!(e.sessionId === null || (typeof e.sessionId === 'string' && e.sessionId.length <= MAX_SESSION_ID_LEN))) return false
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || !Number.isSafeInteger(e.seq) || e.seq < 0) return false
  }
  return true
}

/** @returns {{state:'absent'}|{state:'invalid'}|{state:'valid',gen:number,sha256:string,body:object}} */
function readCopy(path, gen, readFile, maxBytes) {
  let text
  try {
    text = readFile(path, maxBytes)
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' }
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
 * @param {object} [opts.deps]             test seams: writeDurable, readFile, linkSync, syncDir,
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
  const writeDurable = deps.writeDurable ?? writeDurableFile
  const readFile = deps.readFile ?? defaultReadFile
  const link = deps.linkSync ?? linkSync
  const syncDir = deps.syncDir ?? defaultSyncDir
  const afterLoad = deps.afterLoad ?? null
  const maxBytes = deps.maxBytes ?? MAX_STORE_BYTES

  const emit = (level, msg, fields) => {
    try {
      log?.[level]?.(msg, fields)
    } catch { /* a broken logger must not break allocation */ }
  }

  const listGens = () => {
    const gens = new Map()
    for (const name of readdirSync(dir)) {
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
    const a = readCopy(join(dir, genName(top, false)), top, readFile, maxBytes)
    const b = readCopy(join(dir, genName(top, true)), top, readFile, maxBytes)
    const valid = [a, b].filter((c) => c.state === 'valid')
    if (valid.length === 0) return { kind: 'closed', reason: 'evidence_lost' }
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

  /** Evict idempotency records (oldest seq first, never `keep`) until the text fits the budget. */
  const fitBudget = (gen, body, keep) => {
    let text = serialize(gen, body)
    while (Buffer.byteLength(text) > maxBytes) {
      let victim = null
      for (const [id, e] of Object.entries(body.keys)) {
        if (id === keep) continue
        if (victim === null || e.seq < body.keys[victim].seq) victim = id
      }
      if (victim === null) return null
      delete body.keys[victim]
      text = serialize(gen, body)
    }
    return text
  }

  const tryUnlink = (p) => {
    try { unlinkSync(p) } catch { /* ignore */ }
  }

  /**
   * Publish `text` as generation `gen`. Returns 'won' | 'lost' (EEXIST or stale ABA)
   * | 'unsupported' | 'error'. On 'won' the mirror is NOT yet written.
   */
  const publishPrimary = (gen, text) => {
    const primary = join(dir, genName(gen, false))
    const tmp = join(dir, `${TMP_PREFIX}${process.pid}.${randomBytes(6).toString('hex')}`)
    let fd
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeSync(fd, text)
      fsyncSync(fd)
    } catch (err) {
      emit('warn', `session-name temp write failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
      tryUnlink(tmp)
      return 'error'
    }
    try { closeSync(fd) } catch { /* ignore */ }
    try {
      link(tmp, primary)
    } catch (err) {
      tryUnlink(tmp)
      if (err?.code === 'EEXIST') return 'lost'
      if (err?.code === 'EPERM' || err?.code === 'ENOTSUP' || err?.code === 'EOPNOTSUPP' || err?.code === 'ENOSYS') return 'unsupported'
      emit('warn', `session-name publish failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      return 'error'
    }
    tryUnlink(tmp)
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
        return 'lost'
      }
    } catch {
      tryUnlink(primary)
      return 'error'
    }
    return 'won'
  }

  const publishMirror = (gen, text) => {
    try {
      const res = writeDurable(join(dir, genName(gen, true)), text)
      return !!res && res.durable === true
    } catch (err) {
      emit('warn', `session-name mirror write failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      return false
    }
  }

  const prune = (gen) => {
    try {
      for (const name of readdirSync(dir)) {
        const m = FILE_RE.exec(name)
        if (m) {
          if (Number(m[1]) < gen - (KEEP_GENERATIONS - 1)) tryUnlink(join(dir, name))
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
      if (state.kind === 'closed') return failClosed(state.reason)
      if (state.kind === 'error') return { ok: false, reason: state.reason }
      afterLoad?.({ gen: state.gen, attempt })
      const plan = step(state)
      if (plan.done) return plan.done
      const gen = state.gen + 1
      const text = fitBudget(gen, plan.body, plan.keep)
      if (text === null) return { ok: false, reason: 'store_full' }
      const outcome = publishPrimary(gen, text)
      if (outcome === 'lost') continue
      if (outcome === 'unsupported') return { ok: false, reason: 'unsupported_fs' }
      if (outcome === 'error') return { ok: false, reason: 'write_unconfirmed' }
      if (!publishMirror(gen, text)) return { ok: false, reason: 'write_unconfirmed' }
      prune(gen)
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
      project = canonicalProjectForCwd(cwd)
    } catch {
      project = null
    }
    if (!project) return { ok: false, reason: 'non_project' }
    const label = normalizeLabel(project.label)
    if (!label) return { ok: false, reason: 'non_project' }
    const key = keyForLabel(label)
    const root = Array.from(project.root).slice(0, MAX_ROOT_CODE_POINTS).join('')

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
        if (entry && (entry.key !== key || entry.root !== root)) {
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
        const n = Math.max(stored, floor + 1)
        if (n >= Number.MAX_SAFE_INTEGER) return { done: { ok: false, reason: 'exhausted' } }
        setOwn(body.projects, key, { label, root, next: n + 1 })
        if (idempotencyKey !== undefined) {
          body.seq += 1
          setOwn(body.keys, idempotencyKey, { key, root, n, sessionId: null, at: now(), seq: body.seq })
          capKeys(body, idempotencyKey)
        }
        return { body, keep: idempotencyKey, result: result(n) }
      })
    } catch (err) {
      emit('error', `session-name allocator internal error: ${err?.message ?? err}`, { reason: 'internal_error' })
      return { ok: false, reason: 'internal_error' }
    }
  }

  function bind(idempotencyKey, sessionId) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new TypeError('bind: idempotencyKey must be a non-empty string')
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LEN) {
      throw new TypeError('bind: sessionId must be a non-empty string up to 128 chars')
    }
    try {
      return transact((state) => {
        const body = state.body
        expire(body)
        if (!own(body.keys, idempotencyKey)) return { done: { ok: false, reason: 'unknown_key' } }
        const entry = body.keys[idempotencyKey]
        if (entry.sessionId === sessionId) return { done: { ok: true } }
        if (entry.sessionId !== null) return { done: { ok: false, reason: 'already_bound' } }
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
