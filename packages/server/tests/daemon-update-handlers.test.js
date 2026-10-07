import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonUpdateHandlers } from '../src/handlers/daemon-update-handlers.js'
import { DaemonUpdateStatus, PENDING_FILE, POSTPONE_FILE, REQUEST_FILE } from '../src/daemon-update-status.js'
import {
  DaemonUpdateActionSchema, ServerDaemonUpdateActionResultSchema, ServerDaemonUpdateConfirmRequiredSchema,
} from '@chroxy/protocol'

// #8331 — `daemon_update_action`. Real DaemonUpdateStatus over a temp config dir,
// so "a refusal writes nothing" is checked against the directory, not a spy.

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const WS = {}
const NOW = Date.parse('2026-10-07T12:00:00.000Z')

const dirs = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function mkCtx({ idle = () => ({ idle: true, reasons: [], sessions: [] }), withPending = true, updates } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-update-handlers-'))
  dirs.push(dir)
  if (withPending) {
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ target: B, from: A, subject: 's', commitsAhead: 1, queuedAt: new Date(NOW - 1000).toISOString(), reason: 'busy' }))
  }
  const sent = []
  const daemonUpdate = updates === undefined
    ? new DaemonUpdateStatus({ dir, running: A, now: () => NOW, getIdleState: idle })
    : updates
  const ctx = { transport: { send: (_ws, m) => sent.push(m) }, services: { daemonUpdate } }
  return { ctx, sent, dir, daemonUpdate }
}

const primary = { id: 'c1', isPrimaryToken: true, boundSessionId: null }
const pairing = { id: 'c2', isPrimaryToken: false, boundSessionId: null }
const pairingUndefined = { id: 'c3', boundSessionId: null }
const boundPairing = { id: 'c4', isPrimaryToken: false, boundSessionId: 's-1' }
const boundPrimary = { id: 'c5', isPrimaryToken: true, boundSessionId: 's-1' }

const act = (over = {}) => ({ type: 'daemon_update_action', action: 'restart-now', target: B, requestId: 'r-1', ...over })
const handle = (ctx, client, msg) => daemonUpdateHandlers.daemon_update_action(WS, client, msg, ctx)
const written = (dir) => readdirSync(dir).filter((f) => f !== PENDING_FILE)

describe('daemon_update_action — authority', () => {
  it('refuses a pairing, an undefined-class and a bound client with NOT_AUTHORIZED, echoing requestId, and writes no file', () => {
    for (const client of [pairing, pairingUndefined, boundPairing]) {
      for (const action of ['restart-now', 'postpone']) {
        const { ctx, sent, dir } = mkCtx()
        handle(ctx, client, act({ action, confirmBusy: true }))
        assert.equal(sent.length, 1, `${client.id}/${action}`)
        assert.equal(sent[0].type, 'daemon_update_action_result')
        assert.equal(sent[0].ok, false)
        assert.equal(sent[0].code, 'NOT_AUTHORIZED')
        assert.equal(sent[0].requestId, 'r-1')
        assert.deepEqual(written(dir), [], `${client.id}/${action} wrote a file`)
      }
    }
  })

  it('refuses a BOUND client even when it holds the primary token', () => {
    for (const action of ['restart-now', 'postpone']) {
      const { ctx, sent, dir } = mkCtx()
      handle(ctx, boundPrimary, act({ action, confirmBusy: true }))
      assert.equal(sent[0].code, 'NOT_AUTHORIZED')
      assert.deepEqual(written(dir), [])
    }
  })

  it('a refusal never reaches the update module at all', () => {
    const calls = []
    const spy = { requestRestart: () => { calls.push('r') }, postpone: () => { calls.push('p') } }
    for (const client of [pairing, boundPairing, boundPrimary]) {
      const { ctx } = mkCtx({ updates: spy })
      handle(ctx, client, act())
      handle(ctx, client, act({ action: 'postpone' }))
    }
    assert.deepEqual(calls, [])
  })

  it('the strict primary, unbound client is served', () => {
    const { ctx, sent } = mkCtx()
    handle(ctx, primary, act())
    assert.equal(sent[0].ok, true)
  })
})

describe('daemon_update_action — restart-now', () => {
  it('idle: writes the request with force:false and replies ok', () => {
    const { ctx, sent, dir } = mkCtx()
    handle(ctx, primary, act())
    assert.deepEqual(sent.map((m) => [m.type, m.ok, m.force]), [['daemon_update_action_result', true, false]])
    assert.ok(existsSync(join(dir, REQUEST_FILE)))
    assert.ok(ServerDaemonUpdateActionResultSchema.safeParse(sent[0]).success)
  })

  it('busy without confirmBusy: replies confirm_required with the reasons and writes NOTHING', () => {
    const idle = () => ({ idle: false, reasons: ['session "api" busy: turn'], sessions: [{ sessionId: 's1', name: 'api', isBusy: true, busyReason: 'turn', pendingPermissions: 0, pendingQuestions: 0, restartBlockers: [] }] })
    const { ctx, sent, dir } = mkCtx({ idle })
    handle(ctx, primary, act())
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'daemon_update_confirm_required')
    assert.equal(sent[0].requestId, 'r-1')
    assert.equal(sent[0].target, B)
    assert.deepEqual(sent[0].reasons, ['session "api" busy: turn'])
    assert.equal(sent[0].sessions[0].name, 'api')
    assert.ok(ServerDaemonUpdateConfirmRequiredSchema.safeParse(sent[0]).success)
    assert.deepEqual(written(dir), [])
  })

  it('busy with confirmBusy: writes force:true', () => {
    const idle = () => ({ idle: false, reasons: ['busy'], sessions: [] })
    const { ctx, sent, dir } = mkCtx({ idle })
    handle(ctx, primary, act({ confirmBusy: true }))
    assert.deepEqual([sent[0].ok, sent[0].force], [true, true])
    assert.ok(existsSync(join(dir, REQUEST_FILE)))
  })

  it('confirm_required echoes the STORED lowercase target, not what the client typed', () => {
    const idle = () => ({ idle: false, reasons: ['busy'], sessions: [] })
    const { ctx, sent } = mkCtx({ idle })
    handle(ctx, primary, act({ target: B.toUpperCase() }))
    assert.equal(sent[0].type, 'daemon_update_confirm_required')
    assert.equal(sent[0].target, B)
  })

  it('while the update is being applied, both actions are answered APPLYING and write nothing', () => {
    const { ctx, sent, dir } = mkCtx()
    writeFileSync(join(dir, PENDING_FILE), JSON.stringify({ target: B, from: A, subject: 's', commitsAhead: 1, queuedAt: new Date(NOW - 1000).toISOString(), reason: 'applying' }))
    handle(ctx, primary, act())
    handle(ctx, primary, act({ action: 'postpone' }))
    assert.deepEqual(sent.map((m) => m.code), ['APPLYING', 'APPLYING'])
    assert.deepEqual(written(dir), [])
  })

  it('a stale target and an absent update are answered, not applied', () => {
    const stale = mkCtx()
    handle(stale.ctx, primary, act({ target: 'c'.repeat(40) }))
    assert.equal(stale.sent[0].code, 'STALE_TARGET')
    assert.deepEqual(written(stale.dir), [])
    const none = mkCtx({ withPending: false })
    handle(none.ctx, primary, act())
    assert.equal(none.sent[0].code, 'NO_PENDING_UPDATE')
  })
})

describe('daemon_update_action — postpone and edges', () => {
  it('postpone writes the deadline and replies with it', () => {
    const { ctx, sent, dir } = mkCtx()
    handle(ctx, primary, act({ action: 'postpone' }))
    assert.equal(sent[0].ok, true)
    assert.equal(sent[0].postponedUntil, new Date(NOW + 3600e3).toISOString())
    assert.ok(existsSync(join(dir, POSTPONE_FILE)))
    assert.ok(ServerDaemonUpdateActionResultSchema.safeParse(sent[0]).success)
  })

  it('no module wired: UNAVAILABLE; unknown action: UNSUPPORTED_ACTION', () => {
    const none = mkCtx({ updates: null })
    handle(none.ctx, primary, act())
    assert.equal(none.sent[0].code, 'UNAVAILABLE')
    const odd = mkCtx()
    handle(odd.ctx, primary, act({ action: 'detonate' }))
    assert.equal(odd.sent[0].code, 'UNSUPPORTED_ACTION')
    assert.deepEqual(written(odd.dir), [])
  })
})

describe('daemon_update_action — the wire schema', () => {
  it('accepts the two actions and refuses a malformed target or an unknown action', () => {
    assert.ok(DaemonUpdateActionSchema.safeParse(act()).success)
    assert.ok(DaemonUpdateActionSchema.safeParse(act({ action: 'postpone', confirmBusy: false })).success)
    assert.equal(DaemonUpdateActionSchema.safeParse(act({ target: 'main' })).success, false)
    assert.equal(DaemonUpdateActionSchema.safeParse(act({ target: '../../etc/passwd' })).success, false)
    assert.equal(DaemonUpdateActionSchema.safeParse(act({ action: 'rm' })).success, false)
    assert.equal(DaemonUpdateActionSchema.safeParse(act({ confirmBusy: 'yes' })).success, false)
  })
})
