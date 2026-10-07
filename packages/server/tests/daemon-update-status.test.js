import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DaemonUpdateStatus, buildDaemonUpdateStatus, readCappedJson, MAX_FILE_BYTES, POSTPONE_MS,
  PENDING_FILE, POSTPONE_FILE, REQUEST_FILE, LAST_DEPLOY_FILE, REQUEST_TTL_MS,
} from '../src/daemon-update-status.js'
import {
  PENDING_FILE as SCRIPT_PENDING, POSTPONE_FILE as SCRIPT_POSTPONE, REQUEST_FILE as SCRIPT_REQUEST,
  REQUEST_TTL_MS as SCRIPT_TTL,
} from '../../../scripts/deploy-daemon.mjs'
import { ServerDaemonUpdateStatusSchema } from '@chroxy/protocol'

// #8331 — the server half of the update banner. Everything runs against a temp
// config dir (never ~/.chroxy: the sandbox guard would throw).

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

const dirs = []
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), 'chroxy-update-status-')); dirs.push(d); return d }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

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
  return new DaemonUpdateStatus({ dir, running: A, now: () => NOW, getIdleState: IDLE, ...o })
}

describe('file names and TTL match the deploy script (drift guard)', () => {
  it('server constants equal scripts/deploy-daemon.mjs', () => {
    assert.equal(PENDING_FILE, SCRIPT_PENDING)
    assert.equal(POSTPONE_FILE, SCRIPT_POSTPONE)
    assert.equal(REQUEST_FILE, SCRIPT_REQUEST)
    assert.equal(REQUEST_TTL_MS, SCRIPT_TTL)
  })
})

describe('buildDaemonUpdateStatus — validation', () => {
  it('an empty dir is an empty status, and it is a valid wire frame', () => {
    const s = buildDaemonUpdateStatus({ dir: mkDir(), running: A, now: NOW })
    assert.deepEqual(s, { running: A, pending: null, lastDeploy: null, postponedUntil: null, requestPending: false })
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
    put(dir, PENDING_FILE, pending({ queuedAt: '2026-10-07', subject: 's'.repeat(400), reason: 'weird', from: 'garbage', commitsAhead: -3 }))
    const s = buildDaemonUpdateStatus({ dir, running: null, now: NOW })
    assert.equal(s.pending.queuedAt, '2026-10-07T00:00:00.000Z')
    assert.equal(s.pending.subject.length, 200)
    assert.equal(s.pending.reason, 'unknown')
    assert.equal(s.pending.from, null)
    assert.equal(s.pending.commitsAhead, null)
    assert.equal(s.running, null)
    assert.ok(ServerDaemonUpdateStatusSchema.safeParse({ type: 'daemon_update_status', ...s }).success)
  })

  it('postponedUntil only applies to the pending target, and only while in the future', () => {
    const dir = mkDir()
    put(dir, PENDING_FILE, pending())
    put(dir, POSTPONE_FILE, { target: C, until: iso(NOW + 3600e3) })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null, 'another target')
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW - 1) })
    assert.equal(buildDaemonUpdateStatus({ dir, running: A, now: NOW }).postponedUntil, null, 'expired')
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW + 1) })
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
    put(dir, POSTPONE_FILE, { target: B, until: iso(NOW + 3600e3) })
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
    const u = new DaemonUpdateStatus({ dir, running: A, debounceMs: 10, pollMs: 20, getIdleState: IDLE })
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
    const u = new DaemonUpdateStatus({ dir, running: A, debounceMs: 10, pollMs: 25, watch: () => ({ close() {}, on() {} }), getIdleState: IDLE })
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
    const u = new DaemonUpdateStatus({ dir, running: A, pollMs: 25, watch: () => { throw new Error('ENOENT') }, getIdleState: IDLE })
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
    const u = new DaemonUpdateStatus({ dir, running: A, debounceMs: 5, pollMs: 60_000, watch: (_d, _o, fn) => { cb = fn; return { close() {}, on() {} } }, getIdleState: IDLE })
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
    const u = new DaemonUpdateStatus({ dir, running: A, watch: () => ({ close() { closed++ }, on() {} }), getIdleState: IDLE })
    u.start()
    u.close()
    u.close()
    assert.equal(closed, 1)
    u.start()
    assert.equal(u._pollTimer, null, 'a closed instance does not restart')
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
