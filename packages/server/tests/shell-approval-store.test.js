import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ShellApprovalStore } from '../src/shell-approval-store.js'

// #6277 — the host-local user-shell approval store. now()/generateId are
// injectable so TTL + ids are deterministic.

describe('ShellApprovalStore (#6277)', () => {
  it('holds a pending approval with the generated id and a TTL', () => {
    let t = 1000
    const store = new ShellApprovalStore({ now: () => t, generateId: () => 'abc123', ttlMs: 60_000 })
    const { approvalId, expiresAt } = store.createPendingApproval({ clientId: 'c1', createSessionOptions: { cwd: '/tmp' } })
    assert.equal(approvalId, 'abc123')
    assert.equal(expiresAt, 1000 + 60_000)
    assert.equal(store.size, 1)
  })

  it('approve returns the stored entry and is single-use (per-spawn)', () => {
    let t = 1000
    const store = new ShellApprovalStore({ now: () => t, generateId: () => 'x1' })
    store.createPendingApproval({ clientId: 'c1', createSessionOptions: { cwd: '/work' }, tokenClass: 'primary', deviceName: 'mac' })
    const r = store.approve('x1')
    assert.equal(r.ok, true)
    assert.equal(r.entry.clientId, 'c1')
    assert.deepEqual(r.entry.createSessionOptions, { cwd: '/work' })
    assert.equal(r.entry.tokenClass, 'primary')
    assert.equal(store.size, 0)
    // single-use — a second redemption finds nothing.
    assert.deepEqual(store.approve('x1'), { ok: false, reason: 'not_found' })
  })

  it('approve/deny an unknown / empty / non-string id → not_found', () => {
    const store = new ShellApprovalStore()
    assert.deepEqual(store.approve('nope'), { ok: false, reason: 'not_found' })
    assert.deepEqual(store.deny('nope'), { ok: false, reason: 'not_found' })
    assert.deepEqual(store.approve(''), { ok: false, reason: 'not_found' })
    assert.deepEqual(store.approve(null), { ok: false, reason: 'not_found' })
    assert.deepEqual(store.approve(undefined), { ok: false, reason: 'not_found' })
  })

  it('approve after the TTL → expired (and the entry is dropped)', () => {
    let t = 1000
    const store = new ShellApprovalStore({ now: () => t, generateId: () => 'e1', ttlMs: 60_000 })
    store.createPendingApproval({ clientId: 'c1', createSessionOptions: {} })
    t = 1000 + 60_001 // just past expiry
    assert.deepEqual(store.approve('e1'), { ok: false, reason: 'expired' })
    assert.equal(store.size, 0)
  })

  it('deny resolves + removes the entry (single-use)', () => {
    let t = 1000
    const store = new ShellApprovalStore({ now: () => t, generateId: () => 'd1' })
    store.createPendingApproval({ clientId: 'c1', createSessionOptions: {} })
    assert.equal(store.deny('d1').ok, true)
    assert.equal(store.size, 0)
    assert.deepEqual(store.deny('d1'), { ok: false, reason: 'not_found' })
  })

  it('list exposes only non-secret fields (cwd, not the full options)', () => {
    let t = 1000
    let n = 0
    const store = new ShellApprovalStore({ now: () => t, generateId: () => `l${(n += 1)}` })
    store.createPendingApproval({ clientId: 'c1', createSessionOptions: { cwd: '/a', secretEnv: 'SHHH' }, deviceName: 'phone' })
    const list = store.list()
    assert.equal(list.length, 1)
    assert.deepEqual(Object.keys(list[0]).sort(), ['approvalId', 'clientId', 'cwd', 'deviceName', 'expiresAt', 'requestedAt'])
    assert.equal(list[0].cwd, '/a')
    assert.equal(list[0].deviceName, 'phone')
    assert.ok(!('createSessionOptions' in list[0]))
    assert.ok(!('secretEnv' in list[0]))
  })

  it('evicts the oldest pending FIFO past maxPending', () => {
    let t = 1000
    let n = 0
    const store = new ShellApprovalStore({ now: () => t, generateId: () => `f${(n += 1)}`, maxPending: 2, ttlMs: 60_000 })
    const a = store.createPendingApproval({ clientId: 'a', createSessionOptions: {} })
    const b = store.createPendingApproval({ clientId: 'b', createSessionOptions: {} })
    const c = store.createPendingApproval({ clientId: 'c', createSessionOptions: {} }) // evicts a
    assert.equal(store.size, 2)
    assert.deepEqual(store.approve(a.approvalId), { ok: false, reason: 'not_found' }, 'oldest evicted')
    assert.equal(store.approve(b.approvalId).ok, true)
    assert.equal(store.approve(c.approvalId).ok, true)
  })

  it('lazily sweeps expired entries on the next create', () => {
    let t = 1000
    let n = 0
    const store = new ShellApprovalStore({ now: () => t, generateId: () => `s${(n += 1)}`, ttlMs: 100 })
    store.createPendingApproval({ clientId: 'a', createSessionOptions: {} }) // s1, expires 1100
    t = 1201
    store.createPendingApproval({ clientId: 'b', createSessionOptions: {} }) // s2 → sweep drops s1
    assert.equal(store.size, 1)
    assert.deepEqual(store.approve('s1'), { ok: false, reason: 'not_found' })
    assert.equal(store.approve('s2').ok, true)
  })
})
