/**
 * The file ledger: durability, durable idempotency keys, and the
 * single-writer guard (second writer refused, crashed holder taken over,
 * stale holder fenced). Each rule has a mutant that must fail its check.
 */

import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SKIP_NO_SYMLINK } from '../helpers/symlink-support.js'
import { MIN, REAL, STATE_SOURCE, T0, cleanupTmp, cleanupVariants, entry, rig, mustKill } from './helpers/harness.js'

afterEach(() => cleanupTmp())
process.on('exit', cleanupVariants)

const proves = (name, check, mutants = {}, opts = {}) =>
  describe(name, opts, () => {
    it('holds on the real code', async () => {
      await check(REAL)
    })
    for (const [label, edits] of Object.entries(mutants)) it(`mutant "${label}" fails it`, () => mustKill(check, label, edits))
  })

const { keys } = REAL
const edit = (file, from, to) => ({ file, from, to })
const sys = (n, v = 1) => ({ kind: 'system', id: `probe-${n}`, body: { event: 'probe', detail: { v } } })
const LEASE = 15 * MIN

/** Open and fail as an assertion, not as a thrown error, when the open is refused. */
function mustOpen(M, r, opts = {}) {
  try {
    return M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'ledger-test', now: T0, ...opts })
  } catch (err) {
    return assert.fail(`open was refused: ${err.name}: ${err.message}`)
  }
}
const mustRefuse = (M, r, opts = {}) => assert.throws(() => M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'ledger-test', now: T0, ...opts }), (e) => e instanceof M.LedgerHeldError)

function ageLock(r, ms) {
  const t = new Date(T0 - ms)
  fs.utimesSync(path.join(r.ledgerDir, 'ledger.lock'), t, t)
}

// ── the single-writer guard ────────────────────────────────────────────
proves(
  'single writer: a second writer is refused and writes nothing; the holder keeps writing',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    a.append(sys(1), T0)
    const before = fs.readFileSync(r.ledgerFile)
    mustRefuse(M, r, { now: T0 + MIN })
    assert.deepEqual(fs.readFileSync(r.ledgerFile), before, 'the refused writer wrote nothing')
    assert.equal(a.append(sys(2), T0 + 2 * MIN).status, 'appended', 'the holder is untouched by the refusal')
    a.close()
    const b = mustOpen(M, r, { now: T0 + 3 * MIN })
    b.close()
  },
  {
    'no exclusive create': [edit('file-ledger.js', "fs.openSync(lockPath, 'wx', 0o600)", "fs.openSync(lockPath, 'w', 0o600)")],
    'every lock is stale': [edit('file-ledger.js', 'return !isAlive(holder.pid)', 'return true')],
    'the staleness test is skipped': [edit('file-ledger.js', 'if (!rules.isStale({ holder: found.holder, mtimeMs: found.mtimeMs, now, leaseMs, host, isAlive })) {', 'if (false) {')],
  },
)

proves(
  'single writer: a second reconciler on the same ledger is refused and the first still ticks',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - MIN })])
    const first = r.open()
    assert.throws(() => r.open({ now: T0 + MIN }), (e) => e instanceof M.LedgerHeldError)
    const res = first.tick({ source: STATE_SOURCE, slotStart: T0, now: T0 })
    first.close()
    assert.equal(res.reads.length, 1)
    assert.equal(r.kinds('tick').length, 2)
  },
  { 'no exclusive create': [edit('file-ledger.js', "fs.openSync(lockPath, 'wx', 0o600)", "fs.openSync(lockPath, 'w', 0o600)")] },
)

proves(
  'crash: a holder that died is taken over at once on the same host, the takeover is recorded once, and nothing of the dead holder is lost',
  (M) => {
    const r = rig(M)
    const dead = mustOpen(M, r, { pid: 4_000_001, host: 'h1' })
    dead.append(sys(1), T0)
    // no close: the process died holding the lock
    const alive = (pid) => pid === process.pid
    const b = mustOpen(M, r, { now: T0 + MIN, pid: process.pid, host: 'h1', isAlive: alive })
    assert.equal(b.tookOver, true)
    assert.equal(b.epoch, 2)
    assert.equal(b.append(sys(2), T0 + MIN).status, 'appended')
    assert.equal(r.kinds('system', (x) => x.id === 'probe-1').length, 1, 'the dead holder\'s record survives')
    const takeovers = r.kinds('system', (x) => x.body.event === 'writer_takeover')
    assert.equal(takeovers.length, 1)
    assert.equal(takeovers[0].id, keys.systemKey('writer_takeover', ['ledger-test', '2']))
    mustRefuse(M, r, { now: T0 + 2 * MIN, pid: 4_000_002, host: 'h1', isAlive: alive })
    b.close()
  },
  { 'a dead holder is not detected': [edit('file-ledger.js', 'return !isAlive(holder.pid)', 'return false')] },
)

proves(
  'stale holder: a holder silent for more than the lease is taken over, one silent for exactly the lease is not',
  (M) => {
    const r = rig(M)
    const alive = () => true
    const a = mustOpen(M, r, { pid: 4_000_001, host: 'h1', isAlive: alive })
    ageLock(r, LEASE)
    mustRefuse(M, r, { now: T0, host: 'h2', isAlive: alive })
    ageLock(r, LEASE + 1)
    const b = mustOpen(M, r, { now: T0, host: 'h2', isAlive: alive })
    assert.equal(b.tookOver, true)
    b.close()
    void a
  },
  {
    'the lease is never checked': [edit('file-ledger.js', 'return now - mtimeMs > leaseMs', 'return false')],
    'the lease boundary is inclusive': [edit('file-ledger.js', 'return now - mtimeMs > leaseMs', 'return now - mtimeMs >= leaseMs')],
  },
)

proves(
  'stale holder: after a takeover the old holder is fenced and writes nothing',
  (M) => {
    const r = rig(M)
    const alive = () => true
    const a = mustOpen(M, r, { pid: 4_000_001, host: 'h1', isAlive: alive })
    a.append(sys(1), T0)
    ageLock(r, LEASE + 1)
    const b = mustOpen(M, r, { now: T0, host: 'h2', isAlive: alive })
    const before = fs.readFileSync(r.ledgerFile)
    assert.throws(() => a.append(sys(2), T0 + MIN), (e) => e instanceof M.LedgerFencedError)
    assert.deepEqual(fs.readFileSync(r.ledgerFile), before, 'the fenced holder wrote nothing')
    assert.equal(b.append(sys(3), T0 + MIN).status, 'appended')
    // a holder whose lock was removed and replaced by another's fresh one is fenced too
    b.close()
    const c = mustOpen(M, r, { now: T0 + 2 * MIN })
    fs.unlinkSync(path.join(r.ledgerDir, 'ledger.lock'))
    const d = mustOpen(M, r, { now: T0 + 3 * MIN })
    assert.throws(() => c.append(sys(4), T0 + 4 * MIN), (e) => e instanceof M.LedgerFencedError)
    d.close()
    assert.equal(r.kinds('system', (x) => x.id === 'probe-2' || x.id === 'probe-4').length, 0)
  },
  {
    'the fence is never checked': [edit('file-ledger.js', 'if (!found || !rules.holdsLock({ holder: found.holder, token })) {', 'if (false) {')],
    'the fence ignores who holds the lock': [edit('file-ledger.js', 'return Boolean(holder) && holder.holder_id === token.holder_id', 'return Boolean(holder)')],
  },
)

proves(
  'stale holder: a fenced holder closing does not release the lock now held by another',
  (M) => {
    const r = rig(M)
    const alive = () => true
    const a = mustOpen(M, r, { pid: 4_000_001, host: 'h1', isAlive: alive })
    ageLock(r, LEASE + 1)
    const b = mustOpen(M, r, { now: T0, host: 'h2', isAlive: alive })
    a.close()
    mustRefuse(M, r, { now: T0 + MIN, host: 'h3', isAlive: alive })
    b.close()
  },
  { 'release removes any lock': [edit('file-ledger.js', 'if (found && rules.holdsLock({ holder: found.holder, token })) {', 'if (found) {')] },
)

proves(
  'takeover race: a lock replaced while it is being taken over is left alone and the taker is refused',
  (M) => {
    const r = rig(M)
    mustOpen(M, r, { pid: 4_000_001, host: 'h1' })
    const lockPath = path.join(r.ledgerDir, 'ledger.lock')
    const other = JSON.stringify({ holder_id: 'someone-else', pid: process.pid, host: 'h1', epoch: 7, acquired_at: T0 })
    const realRename = fs.renameSync
    fs.renameSync = (from, to) => {
      if (from === lockPath) fs.writeFileSync(lockPath, other) // another contender got there first
      return realRename(from, to)
    }
    try {
      assert.throws(() => M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'ledger-test', now: T0 + MIN, host: 'h1', isAlive: (p) => p === process.pid }), (e) => e instanceof M.LedgerHeldError)
    } finally {
      fs.renameSync = realRename
    }
    assert.ok(fs.existsSync(lockPath), 'the other contender\'s lock was not left deleted')
    assert.equal(fs.readFileSync(lockPath, 'utf8'), other, 'the other contender\'s lock is back in place')
  },
  {
    'the moved lock is not checked': [edit('file-ledger.js', 'if (movedText !== found.text) {', 'if (false) {')],
    'the other lock is not put back': [edit('file-ledger.js', 'if (!fs.existsSync(lockPath)) fs.renameSync(aside, lockPath)', '')],
  },
)

proves(
  'the ledger is kept outside the directories it is told to stay out of',
  (M) => {
    const r = rig(M)
    assert.throws(() => M.openFileLedger({ dir: path.join(r.root, 'daemon', 'freshness'), ledgerId: 'x', now: T0, keepOutOf: [path.join(r.root, 'daemon')] }), TypeError)
    assert.throws(() => M.openFileLedger({ dir: path.join(r.root, 'daemon'), ledgerId: 'x', now: T0, keepOutOf: [path.join(r.root, 'daemon')] }), TypeError)
    const ok = M.openFileLedger({ dir: path.join(r.root, 'daemon-ledger'), ledgerId: 'x', now: T0, keepOutOf: [path.join(r.root, 'daemon')] })
    ok.close()
  },
  { 'the check is skipped': [edit('file-ledger.js', 'if (inside(dir, p) || inside(realish(dir), realish(p))) throw', 'if (false) throw')] },
)

proves(
  'the keep-out check compares real paths: a link to the directory, or a directory that is itself a link, is refused',
  (M) => {
    const r = rig(M)
    const real = path.join(r.root, 'daemon')
    fs.mkdirSync(real)
    const link = path.join(r.root, 'link')
    fs.symlinkSync(real, link, 'dir')
    const refused = (dir, keep) => assert.throws(() => M.openFileLedger({ dir, ledgerId: 'x', now: T0, keepOutOf: [keep] }), TypeError)
    refused(path.join(link, 'ledger'), real) // the ledger is named through a link to the directory
    refused(path.join(real, 'ledger'), link) // the directory is named through a link
    refused(path.join(link, 'a', 'b', 'ledger'), real) // nothing below the link exists yet
    assert.equal(fs.existsSync(path.join(real, 'ledger')), false)
    const ok = M.openFileLedger({ dir: path.join(r.root, 'elsewhere'), ledgerId: 'x', now: T0, keepOutOf: [link] })
    ok.close()
  },
  { 'the check is lexical': [edit('file-ledger.js', 'if (inside(dir, p) || inside(realish(dir), realish(p))) throw', 'if (inside(dir, p)) throw')] },
  { skip: SKIP_NO_SYMLINK },
)

// ── durability ─────────────────────────────────────────────────────────
proves(
  'durable keys: a record repeated after a restart is still a repeat, and a changed one is a conflict',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    a.append(sys(1, 1), T0)
    a.close()
    const b = mustOpen(M, r, { now: T0 + MIN })
    assert.equal(b.append(sys(1, 1), T0 + MIN).status, 'duplicate')
    assert.equal(b.append(sys(1, 2), T0 + MIN).status, 'conflict')
    b.close()
    assert.equal(r.records().length, 3, 'created, the probe and one conflict record')
  },
  { 'the index is not rebuilt from the file': [edit('file-ledger.js', 'const ledger = loadLedger({ ledgerId, records })', 'const ledger = loadLedger({ ledgerId, records: [] })')] },
)

proves(
  'durable keys: the same report read across restarts is one report record',
  (M) => {
    const r = rig(M)
    r.writeState([entry('s1', { state: 'running', updatedAt: T0 - 5 * MIN })])
    r.ticks([T0])
    r.ticks([T0 + 30 * MIN])
    r.ticks([T0 + 60 * MIN])
    assert.equal(r.kinds('report').length, 1)
    assert.equal(r.kinds('check', (x) => x.body.trigger === 'tick').length, 3)
    assert.equal(r.kinds('tick').length, 6)
  },
  { 'the index is not rebuilt from the file': [edit('file-ledger.js', 'const ledger = loadLedger({ ledgerId, records })', 'const ledger = loadLedger({ ledgerId, records: [] })')] },
)

proves(
  'durability: every record is synced before append returns',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    const real = fs.fsyncSync
    let synced = 0
    fs.fsyncSync = (fd) => {
      synced += 1
      return real(fd)
    }
    try {
      for (let i = 0; i < 4; i++) a.append(sys(i), T0 + i)
    } finally {
      fs.fsyncSync = real
    }
    a.close()
    assert.equal(synced, 4)
  },
  { 'no sync': [edit('file-ledger.js', 'fs.fsyncSync(fd)\n      size += line.length', 'size += line.length')] },
)

proves(
  'durability: a write a crash cut off is dropped on open and the ledger is whole afterwards',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    a.append(sys(1), T0)
    a.close()
    const whole = fs.readFileSync(r.ledgerFile)
    fs.appendFileSync(r.ledgerFile, '{"v":1,"seq":3,"kind":"sys')
    const b = mustOpen(M, r, { now: T0 + MIN })
    assert.deepEqual(fs.readFileSync(r.ledgerFile), whole, 'the unacknowledged tail is gone')
    assert.equal(b.append(sys(2), T0 + MIN).status, 'appended')
    b.close()
    const c = mustOpen(M, r, { now: T0 + 2 * MIN })
    assert.equal(c.ledger.records.length, 3)
    c.close()
  },
  { 'the torn tail is kept': [edit('file-ledger.js', "if (tail !== '') {", 'if (false) {')] },
)

proves(
  'durability: a corrupt ledger is refused, not repaired',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    for (let i = 1; i <= 3; i++) a.append(sys(i), T0 + i)
    a.close()
    const text = fs.readFileSync(r.ledgerFile, 'utf8')
    const refuses = (mutated) => {
      fs.writeFileSync(r.ledgerFile, mutated)
      assert.throws(() => M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'ledger-test', now: T0 }), (e) => e instanceof M.LedgerCorruptError)
      assert.equal(fs.readFileSync(r.ledgerFile, 'utf8'), mutated, 'a refused ledger is left as found')
    }
    const lines = text.split('\n').filter(Boolean)
    refuses(text.replace('"v":1', '"v":2').replace('probe-1', 'probe-X')) // an earlier record changed: the next one's hash no longer follows
    const last = JSON.parse(lines[lines.length - 1])
    refuses([...lines.slice(0, -1), JSON.stringify({ ...last, seq: 99 })].join('\n') + '\n') // the last record out of sequence
    refuses(lines[0] + '\nnot json\n' + lines.slice(2).join('\n') + '\n')
  },
  {
    'the hash chain is not checked': [edit('file-ledger.js', 'r.prev !== prev || ', '')],
    'the sequence is not checked': [edit('file-ledger.js', 'r.seq !== i + 1 || ', '')],
  },
)

proves(
  'durability: a ledger made under another ledger id is refused',
  (M) => {
    const r = rig(M)
    mustOpen(M, r).close()
    assert.throws(() => M.openFileLedger({ dir: r.ledgerDir, ledgerId: 'another', now: T0 }), (e) => e instanceof M.LedgerCorruptError)
  },
  { 'the ledger id is not checked': [edit('file-ledger.js', 'if (first && !(first.kind', 'if (false && first && !(first.kind')] },
)

proves(
  'stale holder: a live pid on this host is never stale, however old its lock',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r)
    ageLock(r, 100 * LEASE)
    mustRefuse(M, r, { now: T0 })
    assert.equal(a.append(sys(1), T0).status, 'appended', 'the holder is untouched')
    a.close()
  },
  { 'age alone makes it stale': [edit('file-ledger.js', 'return !isAlive(holder.pid)', 'return !isAlive(holder.pid) || now - mtimeMs > leaseMs')] },
)

proves(
  'lease: the lock\'s time only moves forward whatever now a caller supplies',
  (M) => {
    const r = rig(M)
    const a = mustOpen(M, r, { now: T0 })
    a.append(sys(1), T0 - 60 * MIN)
    const mtime = fs.statSync(path.join(r.ledgerDir, 'ledger.lock')).mtimeMs
    assert.ok(mtime >= T0, 'an older now did not move the lock back')
    a.close()
  },
  { 'the lock time follows the caller': [edit('file-ledger.js', 'new Date(Math.max(now, found.mtimeMs))', 'new Date(now)')] },
)

proves(
  'lease: it must exceed the tick cadence, and by default it is twice the longest cadence',
  (M) => {
    const r = rig(M)
    const cfg = M.coreConfig()
    assert.throws(() => r.open({ config: cfg, leaseMs: 30 * MIN }), TypeError, 'equal to the cadence')
    r.open({ config: cfg, leaseMs: 31 * MIN }).close()
    const slow = M.coreConfig({ cadence_minutes: 120 })
    const a = r.open({ config: slow, pid: 4_000_001, host: 'h1' })
    ageLock(r, 100 * MIN)
    assert.throws(() => r.open({ config: slow, host: 'h2', isAlive: () => true }), (e) => e instanceof M.LedgerHeldError, 'a 100 minute silence is inside a 240 minute default lease')
    void a
  },
  {
    'a lease no longer than the cadence is accepted': [edit('core.js', 'else if (!(leaseMs > cadenceMs))', 'else if (false)')],
    'the default lease ignores the cadence': [edit('core.js', 'Math.max(DEFAULT_LEASE_MS, 2 * cadenceMs)', 'DEFAULT_LEASE_MS')],
  },
)

proves(
  'fence: a writer refuses to write to a file that grew under it, even if the lock still names it',
  (M) => {
    const r = rig(M)
    const noLockCheck = { ...M.writerGuard, assertHeld() {} }
    const a = mustOpen(M, r, { guard: noLockCheck })
    a.append(sys(1), T0)
    fs.appendFileSync(r.ledgerFile, '{"another":"writer"}\n') // a successor wrote in the window
    const before = fs.readFileSync(r.ledgerFile)
    assert.throws(() => a.append(sys(2), T0 + MIN), (e) => e instanceof M.LedgerFencedError)
    assert.deepEqual(fs.readFileSync(r.ledgerFile), before, 'nothing was written')
  },
  { 'the file size is not checked': [edit('file-ledger.js', 'if (fs.fstatSync(fd).size !== size) throw', 'if (false) throw')] },
)
