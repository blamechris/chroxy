import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { constants as fsConstants, openSync as fsOpen, writeSync as fsWriteSync, closeSync as fsClose, renameSync as fsRename } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DaemonUpdateStatus, buildDaemonUpdateStatus, readCappedJson, MAX_FILE_BYTES, POSTPONE_MS,
  PENDING_FILE, POSTPONE_FILE, REQUEST_FILE, LAST_DEPLOY_FILE, REQUEST_TTL_MS, POSTPONE_MAX_MS, REQUEST_SKEW_MS,
} from '../src/daemon-update-status.js'
import {
  PENDING_FILE as SCRIPT_PENDING, POSTPONE_FILE as SCRIPT_POSTPONE, REQUEST_FILE as SCRIPT_REQUEST,
  REQUEST_TTL_MS as SCRIPT_TTL, POSTPONE_MAX_MS as SCRIPT_POSTPONE_MAX, REQUEST_SKEW_MS as SCRIPT_SKEW,
} from '../../../scripts/deploy-daemon.mjs'
import { ServerDaemonUpdateStatusSchema } from '@chroxy/protocol'
import { readBoundedFile } from '../src/utils/small-file.js'

// #8331 — the server half of the update banner. Everything runs against a temp
// config dir (never ~/.chroxy: the sandbox guard would throw).

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

const dirs = []
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), 'chroxy-update-status-')); dirs.push(d); return d }

// Every instance a test starts is closed in teardown, including when an assertion
// throws before the test reaches its own close(). An open watcher or poll interval
// is what keeps `node --test` alive after the summary (#8366).
const live = []
const track = (u) => { live.push(u); return u }
const watcher = (o) => track(new DaemonUpdateStatus(o))
afterEach(() => {
  for (const u of live.splice(0)) u.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const put = (dir, file, value) => writeFileSync(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value))
const get = (dir, file) => (existsSync(join(dir, file)) ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null)
const pending = (o = {}) => ({ target: B, from: A, subject: 'feat: x', commitsAhead: 2, queuedAt: iso(NOW - 60e3), reason: 'busy', ...o })

const IDLE = () => ({ idle: true, reasons: [], sessions: [] })
const BUSY = () => ({
  idle: false,
  reasons: ['session "api" busy: turn'],
  sessions: [{ sessionId: 's1', name: 'api', isBusy: true, busyReason: 'turn', pendingPermissions: 0, pendingQuestions: 0, restartBlockers: [] }],
})

function mk(dir, o = {}) {
  return track(new DaemonUpdateStatus({ dir, running: A, now: () => NOW, getIdleState: IDLE, ...o }))
}

describe('file names and TTL match the deploy script (drift guard)', () => {
  it('server constants equal scripts/deploy-daemon.mjs', () => {
    assert.equal(PENDING_FILE, SCRIPT_PENDING)
    assert.equal(POSTPONE_FILE, SCRIPT_POSTPONE)
    assert.equal(REQUEST_FILE, SCRIPT_REQUEST)
    assert.equal(REQUEST_TTL_MS, SCRIPT_TTL)
    assert.equal(POSTPONE_MAX_MS, SCRIPT_POSTPONE_MAX)
    assert.equal(REQUEST_SKEW_MS, SCRIPT_SKEW)
  })
})

describe('buildDaemonUpdateStatus — validation', () => {
  it('an empty dir is an empty status, and it is a valid wire frame', () => {
    const s = buildDaemonUpdateStatus({ dir: mkDir(), running: A, now: NOW })
    assert.deepEqual(s, { running: A, pending: null, lastDeploy: null, postponedUntil: null, requestPending: false, applying: false })
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...s }).success)
  })

  it('reads a full, valid set and the result parses against the protocol schema', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, LAST_DEPLOY_FILE, { from: A, to: B, at: iso(NOW - 5e3), result: 'ok', subject: 'feat: y' })
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW + 3600e3), requestedAt: iso(NOW) })
    put(dir, REQUEST_FILE, { action: 'restart-now', target: B, force: false, requestedAt: iso(NOW - 1e3), nonce: 'n1' })
    const s = buildDaemonUpdateStatus({ dir, running: A, now: NOW })
    assert.equal(s.pending.target, B)
    assert.equal(s.pending.commitsAhead, 2)
    assert.equal(s.lastDeploy.result, 'ok')
    assert.equal(s.postponedUntil, iso(NOW + 3600e3))
    assert.equal(s.requestPending, true)
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...s }).success)
  })

  it('malformed content reads as ABSENT, never a partial object', () => {
    for (const bad of ['not json', '[]', '"x"', 'null', '{"target":"nope"}', JSON.stringify(pending({ target: 'xyz' })),
      JSON.stringify(pending({ queuedAt: 'yesterday' })), JSON.stringify({ ...pending(), target: undefined })]) {
      const dir = mkDir()
      put(dir, PENDING_FILE, bad)
      assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null, bad.slice(0, 30))
    }
    const dir = mkDir()
    put(dir, LAST_DEPLOY_FILE, { from: A, to: 'nope', at: iso(NOW), result: 'ok' })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).lastDeploy, null)
  })

  it('a file over the size cap reads as absent, and the reader never takes more than cap+1 bytes', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, JSON.stringify({ ...pending(), subject: 'x'.repeat(MAX_FILE_BYTES) }))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null, 'oversize is refused')
    const exact = JSON.stringify(pending())
    put(dir, PENDING_FILE, exact + ' '.repeat(MAX_FILE_BYTES - exact.length))
    assert.equal(readFileSync(join(dir, PENDING_FILE)).length, MAX_FILE_BYTES)
    assert.notEqual(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null, 'exactly the cap is fine')
    // Valid JSON padded past the cap with whitespace: the truncated read still PARSES, so only the
    // explicit size check refuses it. (An oversized body alone would fail to parse and prove nothing.)
    put(dir, PENDING_FILE, exact + ' '.repeat(MAX_FILE_BYTES + 100))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null, 'whitespace-padded oversize is refused')
    put(dir, 'big.json', '{"a":"' + 'x'.repeat(5 * 1024 * 1024) + '"}')
    assert.equal(readCappedJson(join(dir, 'big.json')), null)
  })

  it('canonicalises timestamps, clips subjects, and survives an unknown reason', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending({ queuedAt: '2026-10-07', subject: 's'.repeat(400), reason: 'weird', commitsAhead: -3 }))
    const s = buildDaemonUpdateStatus({ dir, running: A, now: NOW })
    assert.equal(s.pending.queuedAt, '2026-10-07T00:00:00.000Z')
    assert.equal(s.pending.subject.length, 200)
    assert.equal(s.pending.reason, 'unknown')
    assert.equal(s.pending.commitsAhead, null)
    assert.equal(s.running, A)
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...s }).success)
  })

  it('postponedUntil only applies to the pending target, and only while in the future', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, POSTPONE_FILE, { target: C, until: iso(NOW + 3600e3), requestedAt: iso(NOW) })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null, 'another target')
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW - 1), requestedAt: iso(NOW - 3600e3) })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null, 'expired')
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW + 1), requestedAt: iso(NOW - 1000) })
    assert.notEqual(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null)
  })

  it('requestPending needs a FRESH request for the pending target', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const req = (o) => put(dir, REQUEST_FILE, { action: 'restart-now', target: B, force: true, requestedAt: iso(NOW - 1000), nonce: 'n', ...o })
    req({}); assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, true)
    req({ requestedAt: iso(NOW - REQUEST_TTL_MS - 1) }); assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, false, 'stale')
    req({ target: C }); assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, false, 'other target')
    req({}); rmSync(join(dir, PENDING_FILE))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, false, 'nothing is pending')
  })
})

describe('requestRestart', () => {
  it('idle: writes force:false, removes the postpone, and the file has the script\'s shape', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW + 3600e3), requestedAt: iso(NOW) })
    const out = mk(dir).requestRestart({ target: B })
    assert.deepEqual(out, { ok: true, force: false })
    const req = get(dir, REQUEST_FILE)
    assert.equal(req.action, 'restart-now')
    assert.equal(req.target, B)
    assert.equal(req.force, false)
    assert.equal(req.requestedAt, iso(NOW))
    assert.match(req.nonce, /^[A-Za-z0-9._-]{1,64}$/)
    assert.equal(existsSync(join(dir, POSTPONE_FILE)), false)
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no tmp file left behind')
  })

  it('busy WITHOUT confirmation: asks for confirmation and writes NOTHING', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const out = mk(dir, { getIdleState: BUSY }).requestRestart({ target: B })
    assert.equal(out.confirmRequired, true)
    assert.deepEqual(out.reasons, ['session "api" busy: turn'])
    assert.deepEqual(out.sessions, [{ sessionId: 's1', name: 'api', busyReason: 'turn' }])
    assert.equal(existsSync(join(dir, REQUEST_FILE)), false)
  })

  it('busy WITH confirmation: writes force:true', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    assert.deepEqual(mk(dir, { getIdleState: BUSY }).requestRestart({ target: B, confirmBusy: true }), { ok: true, force: true })
    assert.equal(get(dir, REQUEST_FILE).force, true)
  })

  it('a confirmation does not make an idle daemon "forced": force comes from the verdict, never the client', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    assert.deepEqual(mk(dir).requestRestart({ target: B, confirmBusy: true }), { ok: true, force: false })
  })

  it('a verdict that is missing, throws, or is not exactly idle:true is BUSY (fail safe)', () => {
    for (const getIdleState of [null, () => { throw new Error('boom') }, () => ({ idle: 'yes' }), () => ({}), () => null]) {
      const dir = mkDir()
      put(dir, PENDING_FILE, pending())
      const u = mk(dir, { getIdleState })
      assert.equal(u.requestRestart({ target: B }).confirmRequired, true)
      assert.equal(existsSync(join(dir, REQUEST_FILE)), false)
      assert.equal(u.requestRestart({ target: B, confirmBusy: true }).force, true)
    }
  })

  it('refuses a stale target and an absent update, writing nothing', () => {
    const dir = mkDir()
    assert.equal(mk(dir).requestRestart({ target: B }).code, 'NO_PENDING_UPDATE')
    put(dir, PENDING_FILE, pending())
    assert.equal(mk(dir).requestRestart({ target: C }).code, 'STALE_TARGET')
    assert.equal(mk(dir).requestRestart({ target: undefined }).code, 'STALE_TARGET')
    assert.equal(existsSync(join(dir, REQUEST_FILE)), false)
  })

  it('a write failure is reported, not thrown', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    mkdirSync(join(dir, REQUEST_FILE)) // a directory where the file belongs
    assert.equal(mk(dir).requestRestart({ target: B }).code, 'WRITE_FAILED')
  })
})

describe('postpone', () => {
  it('writes target + a deadline one hour out', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const out = mk(dir).postpone({ target: B })
    assert.deepEqual(out, { ok: true, until: iso(NOW + POSTPONE_MS) })
    assert.deepEqual(get(dir, POSTPONE_FILE), { target: B, until: iso(NOW + 3600e3), requestedAt: iso(NOW) })
  })

  it('refuses a stale target or an absent update and writes nothing', () => {
    const dir = mkDir()
    assert.equal(mk(dir).postpone({ target: B }).code, 'NO_PENDING_UPDATE')
    put(dir, PENDING_FILE, pending())
    assert.equal(mk(dir).postpone({ target: C }).code, 'STALE_TARGET')
    assert.equal(existsSync(join(dir, POSTPONE_FILE)), false)
  })
})

describe('the watcher', () => {
  const settle = (ms) => new Promise((r) => setTimeout(r, ms))

  it('emits ONE change when a file appears, none when nothing changed, and stops after close()', async () => {
    const dir = mkDir()
    const u = watcher({ dir, running: A, debounceMs: 10, pollMs: 20, getIdleState: IDLE })
    const seen = []
    u.on('change', (s) => seen.push(s))
    u.start()
    await settle(60)
    assert.equal(seen.length, 0, 'an unchanged status is not news')
    put(dir, PENDING_FILE, pending())
    await settle(150)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].pending.target, B)
    await settle(60)
    assert.equal(seen.length, 1, 'the poll does not repeat it')
    u.close()
    put(dir, PENDING_FILE, pending({ target: C }))
    await settle(80)
    assert.equal(seen.length, 1, 'closed: silent')
  })

  it('the poll delivers a change even when fs.watch never fires', async () => {
    const dir = mkDir()
    const u = watcher({ dir, running: A, debounceMs: 10, pollMs: 25, watch: () => ({ close() {}, on() {} }), getIdleState: IDLE })
    const seen = []
    u.on('change', (s) => seen.push(s))
    u.start()
    put(dir, PENDING_FILE, pending())
    await settle(120)
    assert.equal(seen.length, 1)
    u.close()
  })

  it('a watch that cannot be created falls back to the poll without throwing', async () => {
    const dir = mkDir()
    const u = watcher({ dir, running: A, pollMs: 25, watch: () => { throw new Error('ENOENT') }, getIdleState: IDLE })
    const seen = []
    u.on('change', (s) => seen.push(s))
    u.start()
    put(dir, PENDING_FILE, pending())
    await settle(100)
    assert.equal(seen.length, 1)
    u.close()
  })

  it('events for unrelated files do not trigger a read; the four names do', async () => {
    const dir = mkDir()
    let cb
    const u = watcher({ dir, running: A, debounceMs: 5, pollMs: 60_000, watch: (_d, _o, fn) => { cb = fn; return { close() {}, on() {} } }, getIdleState: IDLE })
    const seen = []
    u.on('change', (s) => seen.push(s))
    u.start()
    put(dir, PENDING_FILE, pending())
    cb('change', 'connection.json')
    await settle(40)
    assert.equal(seen.length, 0, 'an unrelated name is ignored')
    cb('rename', PENDING_FILE)
    await settle(40)
    assert.equal(seen.length, 1)
    u.close()
  })

  it('close() is idempotent and leaves no timers or watchers behind', () => {
    const dir = mkDir()
    let closed = 0
    const u = watcher({ dir, running: A, watch: () => ({ close() { closed++ }, on() {} }), getIdleState: IDLE })
    u.start()
    u.close()
    u.close()
    assert.equal(closed, 1)
    u.start()
    assert.equal(u._pollTimer, null, 'a closed instance does not restart')
  })

  it('close() stops the poll, the pending debounce and the watcher: no tick fires after it (#8366)', async () => {
    const dir = mkDir()
    let fire
    let closed = 0
    const u = watcher({ dir, running: A, debounceMs: 5, pollMs: 5, watch: (_d, _o, fn) => { fire = fn; return { close() { closed++ }, on() {} } }, getIdleState: IDLE })
    u.start()
    // Every poll tick and every debounced read goes through _check() by name, so counting its calls
    // observes the timers themselves. A leaked interval or timer keeps calling it after close().
    let ticks = 0
    u._check = () => { ticks++ }
    fire('rename', PENDING_FILE) // arms the debounce
    u.close()
    ticks = 0
    await settle(60)
    assert.equal(ticks, 0, 'no poll or debounce tick after close()')
    assert.equal(closed, 1, 'the watcher is closed exactly once')
  })

  it('an action emits the new status immediately (no wait for the debounce)', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const u = mk(dir)
    u.start()
    const seen = []
    u.on('change', (s) => seen.push(s))
    u.postpone({ target: B })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].postponedUntil, iso(NOW + POSTPONE_MS))
    u.close()
  })
})

describe('hostile files read as absent and never block (#8331)', () => {
  const posix = process.platform !== 'win32'

  it('a FIFO at a watched name reads as absent WITHOUT blocking (run in a child with a timeout, so a regression fails instead of hanging the run)', { skip: !posix }, () => {
    const dir = mkDir()
    for (const f of [PENDING_FILE, POSTPONE_FILE, REQUEST_FILE, LAST_DEPLOY_FILE]) execFileSync('mkfifo', [join(dir, f)])
    const modulePath = new URL('../src/daemon-update-status.js', import.meta.url).href
    const code = `import { buildDaemonUpdateStatus } from ${JSON.stringify(modulePath)}; ` +
      `const s = buildDaemonUpdateStatus({ dir: ${JSON.stringify(dir)}, running: null, now: ${NOW} }); ` +
      `process.stdout.write(JSON.stringify([s.pending, s.lastDeploy, s.postponedUntil, s.requestPending]))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000 })
    assert.ok(!r.error, `the reader blocked on a FIFO (${r.error && r.error.code})`)
    assert.deepEqual(JSON.parse(r.stdout), [null, null, null, false])
  })

  it('a FIFO that HAS a writer and valid JSON in it is still refused: only a regular file is read', { skip: !posix }, () => {
    const dir = mkDir()
    execFileSync('mkfifo', [join(dir, PENDING_FILE)])
    // Hold both ends open (non-blocking) so nothing here can block, then put a valid document in the pipe.
    const hold = fsOpen(join(dir, PENDING_FILE), fsConstants.O_RDWR | fsConstants.O_NONBLOCK)
    try {
      fsWriteSync(hold, JSON.stringify(pending()))
      assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null)
      assert.match(readBoundedFile(join(dir, PENDING_FILE)).reason, /not a regular file/)
    } finally { fsClose(hold) }
  })

  it('a symlink at a watched name is refused, even to a valid file', { skip: !posix }, () => {
    const dir = mkDir()
    put(dir, 'real.json', pending())
    symlinkSync(join(dir, 'real.json'), join(dir, PENDING_FILE))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null)
    assert.notEqual(readCappedJson(join(dir, 'real.json')), null, 'the target itself reads fine: it is the link that is refused')
  })

  it('a directory at a watched name reads as absent', () => {
    const dir = mkDir()
    mkdirSync(join(dir, PENDING_FILE))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null)
  })
})

describe('writes use unpredictable temp names (#8331)', () => {
  it('a symlink planted at the old predictable temp name is neither followed nor truncated', { skip: process.platform === 'win32' }, () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, 'victim.txt', 'precious')
    for (const f of [REQUEST_FILE, POSTPONE_FILE]) symlinkSync(join(dir, 'victim.txt'), join(dir, `${f}.tmp-${process.pid}`))
    const u = mk(dir)
    assert.deepEqual(u.requestRestart({ target: B }), { ok: true, force: false })
    assert.equal(u.postpone({ target: B }).ok, true)
    assert.equal(readFileSync(join(dir, 'victim.txt'), 'utf8'), 'precious')
  })

  it('a failed write leaves no temp file behind', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    mkdirSync(join(dir, REQUEST_FILE)) // the rename onto a directory fails
    assert.equal(mk(dir).requestRestart({ target: B }).code, 'WRITE_FAILED')
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [])
  })

  it('temp names differ every write', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const names = new Set()
    const u = mk(dir, { now: () => NOW })
    // Spy via the directory: a rename-in-flight is not observable, so assert on the helper directly.
    return import('../src/utils/small-file.js').then(({ writeFileAtomic }) => {
      const seen = []
      const fakeFs = {
        openSync: (p, ...rest) => { seen.push(p); return fsOpen(p, ...rest) },
        writeSync: (fd, ...a) => fsWriteSync(fd, ...a), closeSync: (fd) => fsClose(fd), renameSync: (a, b) => fsRename(a, b), unlinkSync: () => {},
      }
      writeFileAtomic(join(dir, 'x.json'), '{}', { fs: fakeFs })
      writeFileAtomic(join(dir, 'x.json'), '{}', { fs: fakeFs })
      for (const n of seen) names.add(n)
      assert.equal(names.size, 2)
      assert.ok(seen.every((p) => !p.includes(String(process.pid))), 'no pid in the name')
      void u
    })
  })
})

describe('a postpone is bounded (#8331)', () => {
  const setup = (postpone) => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, POSTPONE_FILE, postpone)
    return buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil
  }

  it('a year-9999 deadline is ignored', () => {
    assert.equal(setup({ target: B, until: '9999-12-31T00:00:00.000Z', requestedAt: iso(NOW) }), null)
  })

  it('a far-future requestedAt is ignored, a missing one too', () => {
    assert.equal(setup({ target: B, until: iso(NOW + 400 * 864e5 + 3600e3), requestedAt: iso(NOW + 400 * 864e5) }), null)
    assert.equal(setup({ target: B, until: iso(NOW + 3600e3) }), null)
  })

  it('exactly the server\'s own hour (and a minute of slack) is honoured; a minute more is not', () => {
    assert.notEqual(setup({ target: B, until: iso(NOW + POSTPONE_MAX_MS), requestedAt: iso(NOW) }), null)
    assert.equal(setup({ target: B, until: iso(NOW + POSTPONE_MAX_MS + 1), requestedAt: iso(NOW) }), null)
    assert.notEqual(setup({ target: B, until: iso(NOW + 3600e3), requestedAt: iso(NOW + REQUEST_SKEW_MS) }), null)
    assert.equal(setup({ target: B, until: iso(NOW + 3600e3 + REQUEST_SKEW_MS + 2), requestedAt: iso(NOW + REQUEST_SKEW_MS + 1) }), null)
  })
})

describe('the banner is for an update THIS daemon is waiting on (#8331)', () => {
  const status = (pend, running) => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pend)
    return { dir, s: buildDaemonUpdateStatus({ dir, running, now: NOW }) }
  }

  it('a pending update whose target is what the daemon ALREADY runs reads as no update', () => {
    assert.equal(status(pending({ target: B, from: A }), B).s.pending, null)
  })

  it('a pending update queued FROM another commit (a dev server sharing the config dir) reads as no update', () => {
    assert.equal(status(pending({ target: B, from: C }), A).s.pending, null, 'queued from C, this daemon runs A')
    assert.equal(status(pending({ target: B, from: 'garbage' }), A).s.pending, null, 'no from at all')
  })

  it('a daemon that cannot say what it runs shows no pending update, even when the file has no usable `from` either', () => {
    assert.equal(status(pending(), null).s.pending, null)
    assert.equal(status(pending({ from: 'garbage' }), null).s.pending, null, 'null === null must not read as a match')
  })

  it('a degenerate record whose target equals its own `from` and the running commit shows nothing', () => {
    assert.equal(status(pending({ target: B, from: B }), B).s.pending, null)
  })

  it('the matching case still shows, and actions refuse NO_PENDING_UPDATE in every hidden case', () => {
    assert.notEqual(status(pending({ target: B, from: A }), A).s.pending, null)
    for (const [pend, running] of [[pending({ target: B, from: A }), B], [pending({ target: B, from: C }), A], [pending(), null]]) {
      const { dir } = status(pend, running)
      const u = new DaemonUpdateStatus({ dir, running, now: () => NOW, getIdleState: IDLE })
      assert.equal(u.requestRestart({ target: B }).code, 'NO_PENDING_UPDATE')
      assert.equal(u.postpone({ target: B }).code, 'NO_PENDING_UPDATE')
      assert.equal(existsSync(join(dir, REQUEST_FILE)) || existsSync(join(dir, POSTPONE_FILE)), false)
    }
  })
})

describe('the applying state (#8331)', () => {
  it('reason "applying" is exposed as applying:true', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending({ reason: 'applying', applyingSince: iso(NOW - 60e3) }))
    const s = buildDaemonUpdateStatus({ dir, running: A, now: NOW })
    assert.equal(s.applying, true)
    assert.equal(s.pending.reason, 'applying')
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...s }).success)
    put(dir, PENDING_FILE, pending({ reason: 'busy' }))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).applying, false)
  })

  it('restart-now and postpone are refused with APPLYING, and write nothing', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending({ reason: 'applying', applyingSince: iso(NOW - 60e3) }))
    const u = mk(dir, { getIdleState: BUSY })
    assert.equal(u.requestRestart({ target: B, confirmBusy: true }).code, 'APPLYING')
    assert.equal(u.postpone({ target: B }).code, 'APPLYING')
    assert.equal(existsSync(join(dir, REQUEST_FILE)) || existsSync(join(dir, POSTPONE_FILE)), false)
  })
})

describe('request freshness and timestamp range (#8331)', () => {
  it('a request is fresh for 20 minutes (twice the 600 s launchd interval), not 21', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const at = (min) => put(dir, REQUEST_FILE, { action: 'restart-now', target: B, force: true, requestedAt: iso(NOW - min * 60e3), nonce: 'n' })
    at(19); assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, true)
    at(21); assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, false)
    assert.equal(REQUEST_TTL_MS, 20 * 60 * 1000)
  })

  it('a timestamp outside years 1970-9999 (the extended-year form the wire schema rejects) reads as invalid everywhere', () => {
    const far = '+275760-09-13T00:00:00.000Z'
    const dir = mkDir()
    put(dir, PENDING_FILE, pending({ queuedAt: far }))
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).pending, null)
    put(dir, PENDING_FILE, pending())
    put(dir, LAST_DEPLOY_FILE, { from: A, to: B, at: far, result: 'ok', subject: 's' })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).lastDeploy, null)
    put(dir, POSTPONE_FILE, { target: B, until: far, requestedAt: far })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null)
    put(dir, REQUEST_FILE, { action: 'restart-now', target: B, force: true, requestedAt: far, nonce: 'n' })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).requestPending, false)
    // The frame that does get built always parses.
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...buildDaemonUpdateStatus({ dir, running: A, now: NOW }) }).success)
  })

  it('restart-now echoes the STORED, lowercase target in confirm_required', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    const out = mk(dir, { getIdleState: BUSY }).requestRestart({ target: B.toUpperCase() })
    assert.equal(out.confirmRequired, true)
    assert.equal(out.target, B)
  })
})

describe('a stale applying marker (a crashed tick) is not believed (#8331)', () => {
  const status = (extra) => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending({ reason: 'applying', ...extra }))
    return { dir, s: buildDaemonUpdateStatus({ dir, running: A, now: NOW }) }
  }

  it('missing, invalid, or older than 30 minutes: read as the waiting state, with the buttons working', () => {
    for (const [why, extra] of [
      ['no applyingSince', {}],
      ['invalid applyingSince', { applyingSince: 'last tuesday' }],
      ['31 minutes old', { applyingSince: iso(NOW - 31 * 60e3) }],
      ['far in the future', { applyingSince: iso(NOW + 3600e3) }],
    ]) {
      const { dir, s } = status(extra)
      assert.equal(s.applying, false, why)
      assert.equal(s.pending.reason, 'busy', why)
      const u = mk(dir)
      assert.deepEqual(u.postpone({ target: B }).ok, true, `${why}: Postpone is allowed again`)
    }
  })

  it('a fresh one (29 minutes) is believed', () => {
    const { s } = status({ applyingSince: iso(NOW - 29 * 60e3) })
    assert.equal(s.applying, true)
    assert.equal(s.pending.reason, 'applying')
  })
})
