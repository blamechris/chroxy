import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sessionHandlers } from '../src/handlers/session-handlers.js'
import { nsCtx } from './test-helpers.js'
import { ServerSessionArchivePolicyResultSchema, ClientMessageSchema } from '@chroxy/protocol'

/**
 * set_session_archive_policy (#8869): primary-only, validated, persisted THEN
 * applied. Config persistence is isolated through CHROXY_CONFIG_DIR (read live
 * by configDir()), so nothing here can touch the real ~/.chroxy.
 */

const UNBOUND = { boundSessionId: null }
const BOUND = { boundSessionId: 'b'.repeat(32) }
const GOOD = { type: 'set_session_archive_policy', enabled: true, maxEntries: 50, maxAgeDays: 10, maxMegabytes: 64, requestId: 'r-1' }
const BEFORE = { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 }

function makeCtx({ deleteAllResult = { deleted: 3, failed: 0 } } = {}) {
  const sent = []
  const calls = { set: [], deleteAll: 0 }
  const state = { policy: { ...BEFORE } }
  const config = { port: 1, sessionArchive: { futureKnob: 'x' } }
  const ctx = nsCtx({
    sessionManager: {
      setArchiveRetentionPolicy: (p) => { calls.set.push(p); state.policy = { ...p }; return { ...p } },
      deleteAllArchivedSessions: () => { calls.deleteAll++; return deleteAllResult },
    },
    config,
    transport: { send: (_ws, msg) => sent.push(msg) },
  })
  return { ctx, sent, calls, state, config }
}

describe('set_session_archive_policy', () => {
  let dir
  let prev
  const cfgPath = () => join(dir, 'config.json')
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-archive-policy-'))
    prev = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = dir
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  })

  const run = (client, msg, opts) => {
    const h = makeCtx(opts)
    sessionHandlers.set_session_archive_policy({}, client, msg, h.ctx)
    return h
  }

  it('refuses a bound client FIRST: no validation, no write, no apply', () => {
    for (const client of [BOUND, { boundSessionId: '' }]) {
      // An INVALID policy: if validation ran first the code would be INVALID.
      const { sent, calls } = run(client, { ...GOOD, maxEntries: -5, purge: true })
      assert.equal(sent.length, 1)
      assert.equal(sent[0].ok, false)
      assert.equal(sent[0].refused, true)
      assert.equal(sent[0].code, 'SESSION_ARCHIVE_POLICY_FORBIDDEN_BOUND_CLIENT')
      assert.equal(sent[0].requestId, 'r-1')
      assert.equal(calls.set.length + calls.deleteAll, 0)
      assert.equal(existsSync(cfgPath()), false, 'nothing persisted')
      assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
    }
  })

  it('rejects each invalid field with a field-precise message and changes nothing', () => {
    for (const [patch, field] of [
      [{ enabled: 'yes' }, 'enabled'],
      [{ maxEntries: 0 }, 'maxEntries'],
      [{ maxEntries: 1001 }, 'maxEntries'],
      [{ maxEntries: 2.5 }, 'maxEntries'],
      [{ maxAgeDays: 0 }, 'maxAgeDays'],
      [{ maxAgeDays: Infinity }, 'maxAgeDays'],
      [{ maxMegabytes: -1 }, 'maxMegabytes'],
      [{ maxMegabytes: undefined }, 'maxMegabytes'],
    ]) {
      const { sent, calls } = run(UNBOUND, { ...GOOD, ...patch })
      assert.equal(sent[0].ok, false, JSON.stringify(patch))
      assert.equal(sent[0].code, 'SESSION_ARCHIVE_POLICY_INVALID')
      assert.ok(sent[0].message.includes(field), sent[0].message)
      assert.equal(sent[0].requestId, 'r-1')
      assert.equal(calls.set.length, 0)
      assert.equal(existsSync(cfgPath()), false)
      assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
    }
    assert.ok(run(UNBOUND, { ...GOOD, maxEntries: 1001 }).sent[0].message.includes('1000'), 'names the max')
  })

  it('purge with enabled:true is invalid (and a non-boolean purge too)', () => {
    for (const purge of [true, 'yes']) {
      const { sent, calls } = run(UNBOUND, { ...GOOD, purge })
      assert.equal(sent[0].code, 'SESSION_ARCHIVE_POLICY_INVALID')
      assert.equal(calls.deleteAll, 0)
      assert.equal(calls.set.length, 0)
    }
  })

  it('persist failure replies PERSIST_FAILED and applies NOTHING in memory', () => {
    writeFileSync(cfgPath(), '{ not json')
    const { sent, calls, config } = run(UNBOUND, { ...GOOD, enabled: false, purge: true })
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'SESSION_ARCHIVE_POLICY_PERSIST_FAILED')
    assert.equal(calls.set.length, 0, 'runtime policy untouched')
    assert.equal(calls.deleteAll, 0, 'nothing purged')
    assert.deepEqual(config.sessionArchive, { futureKnob: 'x' }, 'in-memory config untouched')
    assert.equal(readFileSync(cfgPath(), 'utf-8'), '{ not json')
    assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
  })

  it('success applies, persists, updates the in-memory config, and echoes the APPLIED policy', () => {
    writeFileSync(cfgPath(), JSON.stringify({ port: 7, sessionArchive: { futureKnob: 'keep' } }))
    const { sent, calls, config, ctx } = makeCtx()
    // The manager reports a policy that differs from the request, so the reply
    // can only be right if it is read back, not echoed.
    ctx.sessions.sessionManager.setArchiveRetentionPolicy = (p) => { calls.set.push(p); return { ...p, maxMegabytes: 1 } }
    sessionHandlers.set_session_archive_policy({}, UNBOUND, GOOD, ctx)

    assert.deepEqual(calls.set, [{ enabled: true, maxEntries: 50, maxAgeDays: 10, maxMegabytes: 64 }])
    assert.deepEqual(sent, [{ type: 'session_archive_policy_result', ok: true, policy: { enabled: true, maxEntries: 50, maxAgeDays: 10, maxMegabytes: 1 }, requestId: 'r-1' }])
    assert.deepEqual(JSON.parse(readFileSync(cfgPath(), 'utf-8')), {
      port: 7,
      sessionArchive: { futureKnob: 'keep', enabled: true, maxEntries: 50, maxAgeDays: 10, maxMegabytes: 64 },
    })
    assert.deepEqual(config.sessionArchive, { futureKnob: 'x', enabled: true, maxEntries: 50, maxAgeDays: 10, maxMegabytes: 64 })
    assert.equal(config.port, 1)
    assert.equal(calls.deleteAll, 0)
    assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
  })

  it('works without a requestId (none echoed)', () => {
    const { sent } = run(UNBOUND, { ...GOOD, requestId: undefined })
    assert.equal(sent[0].ok, true)
    assert.equal('requestId' in sent[0], false)
  })

  it('turn off + purge deletes every archive and reports the count', () => {
    const { sent, calls } = run(UNBOUND, { ...GOOD, enabled: false, purge: true })
    assert.equal(calls.deleteAll, 1)
    assert.equal(calls.set[0].enabled, false)
    assert.equal(sent[0].ok, true)
    assert.equal(sent[0].deleted, 3)
    assert.equal(sent[0].policy.enabled, false)
    assert.equal(JSON.parse(readFileSync(cfgPath(), 'utf-8')).sessionArchive.enabled, false)
    assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
  })

  it('turning off WITHOUT purge deletes nothing', () => {
    const { sent, calls } = run(UNBOUND, { ...GOOD, enabled: false })
    assert.equal(calls.deleteAll, 0)
    assert.equal(sent[0].ok, true)
    assert.equal('deleted' in sent[0], false)
  })

  it('a partial purge is ok:false PURGE_PARTIAL, but the policy change stood and is reported', () => {
    const { sent, calls } = run(UNBOUND, { ...GOOD, enabled: false, purge: true }, { deleteAllResult: { deleted: 2, failed: 1 } })
    assert.equal(sent[0].ok, false)
    assert.equal(sent[0].code, 'SESSION_ARCHIVE_PURGE_PARTIAL')
    assert.equal(sent[0].deleted, 2)
    assert.equal(sent[0].policy.enabled, false)
    assert.ok(/turned off/i.test(sent[0].message), sent[0].message)
    assert.equal(calls.set.length, 1)
    assert.doesNotThrow(() => ServerSessionArchivePolicyResultSchema.parse(sent[0]))
  })

  it('the client schema requires all four policy fields and accepts purge/requestId', () => {
    const ok = (m) => ClientMessageSchema.safeParse(m).success
    assert.ok(ok(GOOD))
    assert.ok(ok({ ...GOOD, enabled: false, purge: true }))
    for (const k of ['enabled', 'maxEntries', 'maxAgeDays', 'maxMegabytes']) {
      const m = { ...GOOD }
      delete m[k]
      assert.equal(ok(m), false, `missing ${k}`)
    }
  })
})
