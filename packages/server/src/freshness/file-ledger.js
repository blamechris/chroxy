/**
 * A durable, single-writer file ledger for the freshness model.
 *
 * Layout, inside one directory the caller names (kept outside the daemon's own
 * state directory by the caller):
 *
 *   ledger.jsonl   one JSON record per line, in the model's record envelope
 *   ledger.lock    the writer lock (see below)
 *
 * The records are the model's (ledger.js): a record's `id` is its idempotency
 * key, an append whose key exists with the same payload is ignored, one with a
 * different payload writes an `idempotency_conflict` record, and each record
 * carries the hash of the one before it. This module adds only durability and
 * the writer guard. Keys are durable because the in-memory index is rebuilt
 * from the file on open, so a repeat after a restart is still a repeat.
 *
 * Durability. Each record is written as one line with one write and `fsync`ed
 * before `append` returns. On open, a last line with no newline is the tail of
 * a write a crash cut off; it was never acknowledged, so it is dropped (the
 * step that wrote it runs again and writes the same key). A bad line anywhere
 * else, a gap in `seq` or a broken hash chain is corruption: the open is
 * refused with `LedgerCorruptError` and nothing is rewritten.
 *
 * THE SINGLE-WRITER GUARD. Decision: a second writer is REFUSED, not fenced
 * out after the fact, and a STALE holder is fenced.
 *
 *   - `ledger.lock` is created with `O_EXCL`, so exactly one process creates
 *     it. A process that finds it present and its holder live throws
 *     `LedgerHeldError` before it reads or writes the ledger.
 *   - Staleness depends on where the holder runs. On this host, a holder is
 *     stale only if its pid no longer exists: a live pid is never stale,
 *     however old its lock, because a tick can legitimately outlast any lease.
 *     On another host (or when the lock cannot be read) the pid cannot be
 *     checked, so a holder is stale when its lock has not been touched for
 *     `leaseMs` (every append touches it). The lease must exceed the tick
 *     cadence; `openReconciler` enforces that.
 *   - A takeover bumps the lock's `epoch`, and is written to the ledger as a
 *     `writer_takeover` system record.
 *   - Before every append the writer re-reads the lock and writes only if the
 *     lock still names it, and checks that the file is the size this writer
 *     left it at. A holder that was paused, taken over, and woke finds the lock
 *     changed, or the file grown, and its append throws `LedgerFencedError`,
 *     writing nothing.
 *   - The lock's mtime only moves forward, whatever `now` a caller supplies.
 *
 * Residual window, stated rather than hidden: the lock check, the size check
 * and the write are separate steps. A holder taken over, and a successor that
 * writes, inside the microseconds between this writer's size check and its
 * write can still land a duplicate sequence number. The next open then refuses
 * the ledger with `LedgerCorruptError` rather than repairing it, so the damage
 * is detected, not silent, and needs an operator. Pid reuse can make a dead
 * same-host holder look live; the lock is then refused until that pid exits.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonical, sha256 } from './hash.js'
import { append as ledgerAppend, loadLedger } from './ledger.js'
import { systemKey } from './keys.js'

export class LedgerHeldError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerHeldError'
  }
}

export class LedgerFencedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerFencedError'
  }
}

export class LedgerCorruptError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerCorruptError'
  }
}

export const LEDGER_FILE = 'ledger.jsonl'
export const LOCK_FILE = 'ledger.lock'
export const DEFAULT_LEASE_MS = 15 * 60_000

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** The rules the guard applies. A test replaces one at a time to prove each is load-bearing. */
export const DEFAULT_GUARD_RULES = Object.freeze({
  /**
   * Is this lock's holder gone? `holder` is the parsed lock (null when it
   * could not be parsed), `mtimeMs` the lock file's last touch.
   */
  isStale({ holder, mtimeMs, now, leaseMs, host, isAlive }) {
    // On this host the pid decides: a live pid is never stale, whatever the age.
    if (holder && holder.host === host && Number.isSafeInteger(holder.pid)) return !isAlive(holder.pid)
    // Elsewhere the pid cannot be checked; only silence for the lease counts.
    return now - mtimeMs > leaseMs
  },
  /** May this process write? The lock must still name it (holder ids are unique per acquire). */
  holdsLock({ holder, token }) {
    return Boolean(holder) && holder.holder_id === token.holder_id
  },
})

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * The real path of `p`: the real path of its deepest existing ancestor with the
 * names below it (which do not exist yet) appended. A symlink anywhere above
 * the path is resolved, so two spellings of one directory compare equal.
 */
function realish(p) {
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse())
    } catch (err) {
      const parent = path.dirname(cur)
      if (parent === cur || (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR')) return path.resolve(p)
      tail.push(path.basename(cur))
      cur = parent
    }
  }
}

function readLock(lockPath) {
  let text
  let mtimeMs
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs
    text = fs.readFileSync(lockPath, 'utf8')
  } catch {
    return null
  }
  try {
    const holder = JSON.parse(text)
    if (holder && typeof holder === 'object' && typeof holder.holder_id === 'string' && Number.isSafeInteger(holder.epoch)) return { holder, text, mtimeMs }
  } catch {
    // A lock whose creator died between creating and writing it has no content.
  }
  return { holder: null, text, mtimeMs }
}

function createLock(lockPath, content) {
  const fd = fs.openSync(lockPath, 'wx', 0o600)
  try {
    fs.writeSync(fd, JSON.stringify(content))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // The lease is measured on the caller's clock, so the lock is stamped with it.
  const t = new Date(content.acquired_at)
  fs.utimesSync(lockPath, t, t)
}

/**
 * The writer guard: `acquire`, `assertHeld`, `release`. `rules` are the
 * decisions (DEFAULT_GUARD_RULES); the rest is mechanism.
 */
export function createWriterGuard(rules = DEFAULT_GUARD_RULES) {
  return Object.freeze({
    /** Returns the token this writer holds, or throws `LedgerHeldError`. */
    acquire(lockPath, { now, leaseMs = DEFAULT_LEASE_MS, pid = process.pid, host = os.hostname(), isAlive = pidAlive } = {}) {
      const token = { holder_id: randomUUID(), pid, host, epoch: 1, acquired_at: now, took_over_from: null }
      try {
        createLock(lockPath, token)
        return token
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
      }
      const found = readLock(lockPath)
      if (!found) {
        // It vanished between our create and our read: try once more from scratch.
        createLockOrHeld(lockPath, token)
        return token
      }
      if (!rules.isStale({ holder: found.holder, mtimeMs: found.mtimeMs, now, leaseMs, host, isAlive })) {
        const who = found.holder ? `pid ${found.holder.pid} on ${found.holder.host}` : 'an unknown process'
        throw new LedgerHeldError(`ledger is held by ${who}; a second writer is refused`)
      }
      // Take over a stale lock. Move it aside so that only one contender can
      // have removed it, check that what we moved is the lock we judged
      // stale, then create ours exclusively.
      const aside = `${lockPath}.stale-${token.holder_id}`
      try {
        fs.renameSync(lockPath, aside)
      } catch {
        throw new LedgerHeldError('ledger lock changed while taking it over; a second writer is refused')
      }
      let movedText = null
      try {
        movedText = fs.readFileSync(aside, 'utf8')
      } catch {
        // fall through: treated as "not the lock we judged"
      }
      if (movedText !== found.text) {
        // We moved a lock another contender had just created. Put it back if its path is free.
        try {
          if (!fs.existsSync(lockPath)) fs.renameSync(aside, lockPath)
        } catch {
          // Nothing more can be done safely; the caller is refused below.
        }
        throw new LedgerHeldError('ledger lock was replaced while taking it over; a second writer is refused')
      }
      try {
        fs.unlinkSync(aside)
      } catch {
        // A leftover `.stale-` file is harmless.
      }
      token.epoch = (found.holder?.epoch ?? 0) + 1
      token.took_over_from = found.holder ? found.holder.holder_id : 'unreadable'
      createLockOrHeld(lockPath, token)
      return token
    },

    /** Throws `LedgerFencedError` unless the lock still names this writer. Touches it as the lease heartbeat. */
    assertHeld(lockPath, token, now) {
      const found = readLock(lockPath)
      if (!found || !rules.holdsLock({ holder: found.holder, token })) {
        throw new LedgerFencedError('this writer no longer holds the ledger lock; nothing was written')
      }
      try {
        const t = new Date(Math.max(now, found.mtimeMs))
        fs.utimesSync(lockPath, t, t)
      } catch {
        // The heartbeat is best effort; the next append re-checks the lock.
      }
    },

    /** Remove the lock if it is still ours. */
    release(lockPath, token) {
      const found = readLock(lockPath)
      if (found && rules.holdsLock({ holder: found.holder, token })) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          // Already gone.
        }
      }
    },
  })
}

function createLockOrHeld(lockPath, token) {
  try {
    createLock(lockPath, token)
  } catch (err) {
    if (err?.code === 'EEXIST') throw new LedgerHeldError('another writer took the ledger first; a second writer is refused')
    throw err
  }
}

export const writerGuard = createWriterGuard()

function loadRecords(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r+')
  } catch (err) {
    if (err?.code === 'ENOENT') return []
    throw err
  }
  try {
    const text = fs.readFileSync(fd, 'utf8')
    if (text === '') return []
    const lines = text.split('\n')
    const tail = lines.pop()
    if (tail !== '') {
      // A write the crash cut off: it was never acknowledged. Drop it.
      const keep = Buffer.byteLength(lines.length ? lines.join('\n') + '\n' : '')
      fs.ftruncateSync(fd, keep)
      fs.fsyncSync(fd)
    }
    const records = []
    let prev = null
    lines.forEach((line, i) => {
      let r
      try {
        r = JSON.parse(line)
      } catch {
        throw new LedgerCorruptError(`ledger line ${i + 1} is not valid JSON; refusing to open`)
      }
      if (!r || r.seq !== i + 1 || r.prev !== prev || typeof r.id !== 'string') {
        throw new LedgerCorruptError(`ledger record ${i + 1} breaks the sequence or hash chain; refusing to open`)
      }
      prev = sha256(canonical(r))
      records.push(r)
    })
    return records
  } finally {
    fs.closeSync(fd)
  }
}

function writeAll(fd, buf) {
  let off = 0
  while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off)
}

/** Throw unless `dir` is outside every directory of `keepOutOf`, by lexical and by real path. */
export function assertKeptOutOf(dir, keepOutOf, what) {
  for (const p of keepOutOf) {
    if (inside(dir, p) || inside(realish(dir), realish(p))) throw new TypeError(`openFileLedger: ${what} must be kept outside ${p}`)
  }
}

/**
 * Open the ledger in `dir` for writing, holding the writer lock.
 *
 * @param {object} opts
 * @param {string} opts.dir            directory for ledger.jsonl and ledger.lock
 * @param {string} opts.ledgerId       the ledger's identity (part of every tick id)
 * @param {number} opts.now            time of the open, ms
 * @param {number} [opts.leaseMs]
 * @param {string[]} [opts.keepOutOf]  directories the ledger must not be in or under (the daemon's own state directory)
 * @param {object} [opts.guard]        the writer guard (writerGuard)
 * @param {number} [opts.pid]          for tests
 * @param {string} [opts.host]         for tests
 * @param {(pid:number)=>boolean} [opts.isAlive]  for tests
 * @returns {{ ledger, append(draft, at), close(), epoch, tookOver, path }}
 */
export function openFileLedger({ dir, ledgerId, now, leaseMs = DEFAULT_LEASE_MS, guard = writerGuard, keepOutOf = [], pid, host, isAlive }) {
  if (!dir || !ledgerId) throw new TypeError('openFileLedger: dir and ledgerId are required')
  assertKeptOutOf(dir, keepOutOf, 'the ledger')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, LEDGER_FILE)
  const lockPath = path.join(dir, LOCK_FILE)
  const token = guard.acquire(lockPath, { now, leaseMs, ...(pid !== undefined ? { pid } : {}), ...(host !== undefined ? { host } : {}), ...(isAlive ? { isAlive } : {}) })
  let fd = null
  let broken = false
  const handle = {}
  try {
    const records = loadRecords(file)
    const ledger = loadLedger({ ledgerId, records })
    fd = fs.openSync(file, 'a', 0o600)
    // The file is the size this writer left it at, or someone else wrote to it.
    let size = fs.fstatSync(fd).size
    const persist = (record) => {
      const line = Buffer.from(JSON.stringify(record) + '\n')
      writeAll(fd, line)
      fs.fsyncSync(fd)
      size += line.length
    }
    const write = (draft, at) => {
      if (broken) throw new Error('ledger handle is broken by an earlier failed write; reopen it')
      guard.assertHeld(lockPath, token, at)
      if (fs.fstatSync(fd).size !== size) throw new LedgerFencedError('the ledger changed under this writer; nothing was written')
      const reply = ledgerAppend(ledger, draft, at)
      if (reply.record) {
        try {
          persist(reply.record)
        } catch (err) {
          broken = true
          throw err
        }
      }
      return reply
    }
    const first = records[0]
    if (first && !(first.kind === 'system' && first.body?.event === 'ledger_created' && first.body.detail?.ids?.[0] === ledgerId)) {
      throw new LedgerCorruptError('ledger was created under a different ledger id; refusing to open')
    }
    if (!first) write({ kind: 'system', id: systemKey('ledger_created', [ledgerId]), body: { event: 'ledger_created', detail: { ids: [ledgerId] } } }, now)
    if (token.took_over_from) {
      write({ kind: 'system', id: systemKey('writer_takeover', [ledgerId, String(token.epoch)]), body: { event: 'writer_takeover', detail: { ids: [ledgerId, String(token.epoch)], previous_holder: token.took_over_from } } }, now)
    }
    Object.assign(handle, {
      ledger,
      append: write,
      epoch: token.epoch,
      tookOver: Boolean(token.took_over_from),
      path: file,
      close() {
        if (fd != null) fs.closeSync(fd)
        fd = null
        guard.release(lockPath, token)
      },
    })
    return handle
  } catch (err) {
    if (fd != null) fs.closeSync(fd)
    guard.release(lockPath, token)
    throw err
  }
}
