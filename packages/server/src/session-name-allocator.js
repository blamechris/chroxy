/**
 * Project-scoped incrementing session names ("chroxy 7") — the durable allocator.
 *
 * NOT WIRED INTO ANYTHING (slice N1). `SessionManager.createSession` is
 * synchronous, so this module is synchronous end to end: a cross-process lock
 * taken with `openSync(..., 'wx')`, a bounded `Atomics.wait` back-off, and
 * `writeDurableFile` (write, fsync, rename, fsync dir) for every persisted byte.
 *
 * ## Evidence: two mirrored copies
 *
 *   <dir>/session-names.json          (A)
 *   <dir>/session-names.mirror.json   (B)
 *
 * Each holds `{ version: 1, gen, body, sha256 }` where `sha256` covers a
 * canonical (sorted-key) serialization of `{ version, gen, body }`. A write
 * bumps `gen`, writes A and then B, and a number is ISSUED only after BOTH
 * returned `{ durable: true }`. If either throws or is unconfirmed the number is
 * not issued; it may already be persisted as `next`, so it becomes a gap and
 * is never reused.
 *
 * Every allocate/bind re-loads both copies under the lock (no in-memory cache):
 *   - both absent                 -> fresh (gen 0)
 *   - >= 1 valid                  -> the valid copy with the highest gen
 *                                    (two valid at one gen with different
 *                                    sha256 -> fail closed: 'inconsistent')
 *   - present but none valid      -> fail closed: 'evidence_lost'
 *
 * Failing closed returns `{ ok: false, reason }` from allocate and bind and
 * WRITES NOTHING — no quarantine, rename or repair — so corrupt evidence keeps
 * the allocator closed across restarts. Callers use their legacy names.
 *
 * ## Guarantee (narrowed on purpose)
 *
 * A number issued for a key is never issued again for that key while at least
 * one of the two durable copies that recorded it survives intact. If copies
 * exist but none is valid, numbered allocation fails closed (callers use legacy
 * names) and the allocator writes nothing until an operator removes the naming
 * files. If both naming files are deleted, that is indistinguishable from first
 * use: numbering restarts above the highest number in LIVE session names, and
 * numbers that belonged only to deleted sessions or unused allocations may be
 * issued again — this case is outside the guarantee.
 *
 * ## Operator recovery from a fail-closed state
 *
 * Stop the daemon, remove `session-names.json`, `session-names.mirror.json`
 * (and a stale `session-names.lock` if one is left), then start it again.
 * Accepted cost: numbers may repeat those of sessions that no longer exist.
 *
 * ## Other behaviour
 *
 * - Live floor: n = max(stored next, highest live "<key> <n>" + 1).
 * - Idempotency keys (<= 512 entries, <= 24 h) let a retried create reuse its
 *   unbound number instead of burning a new one; a key reused for a different
 *   project is refused, never remapped.
 * - Numbers stop at MAX_SAFE_INTEGER - 1 ('exhausted'), so `next` stays a safe
 *   integer.
 * - Stale-lock removal re-reads the lock before unlinking, and the holder
 *   re-checks its own token before writing. That narrows, but cannot close,
 *   the window in which two processes both judge one lock stale.
 * - Nothing here throws for I/O, lock or corruption problems; those return
 *   `{ ok: false, reason }`. Only bad arguments throw (programming errors).
 */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { canonicalProjectForCwd } from '@chroxy/protocol/project'
import { configDir } from './config-dir.js'
import { writeDurableFile } from './durable-write.js'

export const NAME_FILE = 'session-names.json'
export const MIRROR_FILE = 'session-names.mirror.json'
export const LOCK_FILE = 'session-names.lock'

const VERSION = 1
const MAX_FILE_BYTES = 256 * 1024
const MAX_LABEL_CODE_POINTS = 64
const MAX_KEYS = 512
const KEY_TTL_MS = 24 * 60 * 60 * 1000
const LOCK_STALE_MS = 30 * 1000
const MAX_IDEM_KEY_LEN = 256

// Once per process per (dir, reason) — a closed allocator is polled on every create.
const loggedFailClosed = new Set()

function defaultReadFile(path) {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.size > MAX_FILE_BYTES) {
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

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function monotonicNow() {
  return Number(process.hrtime.bigint() / 1000000n)
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
  for (const p of Object.values(body.projects)) {
    if (!isObj(p) || typeof p.label !== 'string' || typeof p.root !== 'string' || !isInt(p.next)) return false
  }
  for (const k of Object.values(body.keys)) {
    if (!isObj(k) || typeof k.key !== 'string' || !isInt(k.n)) return false
    if (!(k.sessionId === null || typeof k.sessionId === 'string')) return false
    if (typeof k.at !== 'number' || !Number.isFinite(k.at)) return false
  }
  return true
}

/** @returns {{state:'absent'}|{state:'invalid'}|{state:'valid',gen:number,sha256:string,body:object}} */
function readCopy(path, readFile) {
  let text
  try {
    text = readFile(path)
  } catch (err) {
    return err?.code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' }
  }
  try {
    const doc = JSON.parse(text)
    if (!isObj(doc) || doc.version !== VERSION || !isInt(doc.gen) || typeof doc.sha256 !== 'string') return { state: 'invalid' }
    if (!validBody(doc.body)) return { state: 'invalid' }
    if (digest(doc.version, doc.gen, doc.body) !== doc.sha256) return { state: 'invalid' }
    return { state: 'valid', gen: doc.gen, sha256: doc.sha256, body: doc.body }
  } catch {
    return { state: 'invalid' }
  }
}

const emptyBody = () => ({ projects: {}, keys: {} })
const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
// Plain `obj[k] = v` with k === '__proto__' would rewrite the prototype, not add a key.
const setOwn = (obj, k, v) => Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true })

/**
 * @param {object} opts
 * @param {string} [opts.dir]              defaults to the config dir (honours CHROXY_CONFIG_DIR)
 * @param {() => string[]} [opts.liveNames] names of sessions that exist right now
 * @param {() => number} [opts.now]        wall clock (idempotency ages)
 * @param {{warn?:Function,error?:Function,info?:Function}} [opts.log]
 * @param {number} [opts.lockTimeoutMs]
 * @param {object} [opts.deps]             test seams: writeDurable, readFile, openLock, afterLoad,
 *                                         isPidAlive, sleep, monotonic
 */
export function createSessionNameAllocator({
  dir = configDir(),
  liveNames = () => [],
  now = Date.now,
  log = {},
  lockTimeoutMs = 50,
  deps = {},
} = {}) {
  const writeDurable = deps.writeDurable ?? writeDurableFile
  const readFile = deps.readFile ?? defaultReadFile
  const openLock = deps.openLock ?? ((p) => openSync(p, 'wx'))
  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive
  const sleep = deps.sleep ?? defaultSleep
  const monotonic = deps.monotonic ?? monotonicNow
  const afterLoad = deps.afterLoad ?? null
  const host = hostname()

  const pathA = join(dir, NAME_FILE)
  const pathB = join(dir, MIRROR_FILE)
  const lockPath = join(dir, LOCK_FILE)

  const emit = (level, msg, fields) => {
    try {
      log?.[level]?.(msg, fields)
    } catch { /* a broken logger must not break allocation */ }
  }

  // ---- lock -----------------------------------------------------------
  const readLock = () => {
    try {
      return readFileSync(lockPath, 'utf8')
    } catch {
      return null
    }
  }

  const lockIsStale = (text) => {
    let info = null
    try {
      info = JSON.parse(text)
    } catch { /* torn write: judged by age below */ }
    if (!isObj(info) || !Number.isFinite(info.startedAt)) return false // creator may still be writing it
    if (Date.now() - info.startedAt > LOCK_STALE_MS) return true
    return info.host === host && Number.isInteger(info.pid) && !isPidAlive(info.pid)
  }

  const acquire = () => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      return { ok: false, reason: 'lock_error' }
    }
    const token = randomBytes(8).toString('hex')
    const body = JSON.stringify({ pid: process.pid, startedAt: Date.now(), host, token })
    const deadline = monotonic() + lockTimeoutMs
    let backoff = 1
    for (;;) {
      let fd
      try {
        fd = openLock(lockPath)
      } catch (err) {
        if (err?.code !== 'EEXIST') return { ok: false, reason: 'lock_error' }
      }
      if (fd !== undefined) {
        try {
          writeSync(fd, body)
        } catch {
          try { closeSync(fd) } catch { /* ignore */ }
          try { unlinkSync(lockPath) } catch { /* ignore */ }
          return { ok: false, reason: 'lock_error' }
        }
        try { closeSync(fd) } catch { /* ignore */ }
        return { ok: true, token }
      }
      const seen = readLock()
      if (seen !== null && lockIsStale(seen)) {
        if (readLock() === seen) {
          try { unlinkSync(lockPath) } catch { /* someone else removed it */ }
        }
        continue
      }
      if (monotonic() >= deadline) return { ok: false, reason: 'lock_timeout' }
      sleep(backoff)
      backoff = Math.min(backoff * 2, 8)
    }
  }

  const stillOurs = (token) => {
    const text = readLock()
    if (text === null) return false
    try {
      return JSON.parse(text)?.token === token
    } catch {
      return false
    }
  }

  const release = (token) => {
    if (!stillOurs(token)) return
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }

  // ---- evidence -------------------------------------------------------
  const load = () => {
    const a = readCopy(pathA, readFile)
    const b = readCopy(pathB, readFile)
    if (a.state === 'absent' && b.state === 'absent') {
      return { kind: 'fresh', gen: 0, body: emptyBody(), inSync: true }
    }
    const valid = [a, b].filter((c) => c.state === 'valid')
    if (valid.length === 0) return { kind: 'closed', reason: 'evidence_lost' }
    valid.sort((x, y) => y.gen - x.gen)
    const best = valid[0]
    if (valid.length === 2 && valid[0].gen === valid[1].gen && valid[0].sha256 !== valid[1].sha256) {
      return { kind: 'closed', reason: 'inconsistent' }
    }
    const inSync = valid.length === 2 && valid[0].gen === valid[1].gen
    return { kind: 'ok', gen: best.gen, body: structuredClone(best.body), inSync }
  }

  const failClosed = (reason) => {
    const k = `${dir}\u0000${reason}`
    if (!loggedFailClosed.has(k)) {
      loggedFailClosed.add(k)
      emit('error', `session-name allocator closed (${reason}); numbered names disabled until the naming files in ${dir} are removed`, { reason })
    }
    return { ok: false, reason }
  }

  /** Persist body at gen+1 to both copies; true only when both are confirmed durable. */
  const persist = (state, body) => {
    const gen = state.gen + 1
    const text = JSON.stringify({ version: VERSION, gen, body, sha256: digest(VERSION, gen, body) })
    try {
      for (const p of [pathA, pathB]) {
        const res = writeDurable(p, text)
        if (!res || res.durable !== true) return false
      }
      return true
    } catch (err) {
      emit('warn', `session-name write failed: ${err?.message ?? err}`, { reason: 'write_unconfirmed' })
      return false
    }
  }

  const prune = (keys) => {
    const t = now()
    const entries = Object.entries(keys).filter(([, e]) => t - e.at <= KEY_TTL_MS)
    entries.sort((x, y) => x[1].at - y[1].at)
    const kept = entries.slice(Math.max(0, entries.length - MAX_KEYS))
    const out = {}
    for (const [k, e] of kept) setOwn(out, k, e)
    return out
  }

  const withLock = (fn) => {
    const lock = acquire()
    if (!lock.ok) return lock
    try {
      return fn(lock.token)
    } catch (err) {
      emit('error', `session-name allocator internal error: ${err?.message ?? err}`, { reason: 'internal_error' })
      return { ok: false, reason: 'internal_error' }
    } finally {
      release(lock.token)
    }
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

    return withLock((token) => {
      const state = load()
      if (state.kind === 'closed') return failClosed(state.reason)
      afterLoad?.({ phase: 'allocate', key })

      let live
      try {
        live = Array.from(liveNames() ?? [], (n) => String(n).normalize('NFC').toLowerCase())
      } catch {
        return { ok: false, reason: 'live_names_failed' }
      }
      const liveSet = new Set(live)
      const re = new RegExp(`^${escapeRegExp(key)} (\\d+)$`)
      let floor = 0
      for (const name of live) {
        const m = re.exec(name)
        if (!m) continue
        const v = Number(m[1])
        if (!Number.isSafeInteger(v)) return { ok: false, reason: 'exhausted' }
        if (v > floor) floor = v
      }

      const body = state.body
      const result = (n) => ({ ok: true, name: `${label} ${n}`, label, number: n, key })
      const entry = idempotencyKey !== undefined && own(body.keys, idempotencyKey) ? body.keys[idempotencyKey] : null
      if (entry && entry.key !== key) return { ok: false, reason: 'idempotency_key_conflict' }

      if (entry) {
        const held = liveSet.has(`${key} ${entry.n}`)
        if (entry.sessionId === null && !held) {
          // A retry of a create whose number was never bound: hand the same one back.
          // Both copies must carry it first — repair a lagging mirror before issuing.
          if (state.inSync) return result(entry.n)
          if (!stillOurs(token)) return { ok: false, reason: 'lock_lost' }
          return persist(state, body) ? result(entry.n) : { ok: false, reason: 'write_unconfirmed' }
        }
        emit('warn', `duplicate_create_request: idempotency key already ${entry.sessionId !== null ? 'bound to a session' : 'held by a live session'}; allocating a fresh number`, {
          reason: 'duplicate_create_request', key, n: entry.n,
        })
      }

      const stored = own(body.projects, key) ? body.projects[key].next : 1
      const n = Math.max(stored, floor + 1)
      if (n >= Number.MAX_SAFE_INTEGER) return { ok: false, reason: 'exhausted' }
      setOwn(body.projects, key, { label, root: project.root, next: n + 1 })
      if (idempotencyKey !== undefined) setOwn(body.keys, idempotencyKey, { key, n, sessionId: null, at: now() })
      body.keys = prune(body.keys)

      if (!stillOurs(token)) return { ok: false, reason: 'lock_lost' }
      if (!persist(state, body)) return { ok: false, reason: 'write_unconfirmed' }
      return result(n)
    })
  }

  function bind(idempotencyKey, sessionId) {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) throw new TypeError('bind: idempotencyKey must be a non-empty string')
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('bind: sessionId must be a non-empty string')
    return withLock((token) => {
      const state = load()
      if (state.kind === 'closed') return failClosed(state.reason)
      afterLoad?.({ phase: 'bind', key: idempotencyKey })
      const body = state.body
      if (!own(body.keys, idempotencyKey)) return { ok: false, reason: 'unknown_key' }
      body.keys[idempotencyKey].sessionId = sessionId
      if (!stillOurs(token)) return { ok: false, reason: 'lock_lost' }
      return persist(state, body) ? { ok: true } : { ok: false, reason: 'write_unconfirmed' }
    })
  }

  return { allocate, bind }
}
