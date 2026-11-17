/**
 * The persistent kill switch file and state machine (agent-principals.md section 10.2):
 * memory first, then the durable write, boot read that fails closed, a real restart,
 * and the store brakes (`state()` is the one choke point).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PrincipalKillSwitch } from '../src/principal-kill-switch.js'
import { createPrincipalBrakes } from '../src/principal-brakes.js'
import { PrincipalStore } from '../src/principal-store.js'
import { writeDurableFile } from '../src/durable-write.js'
import { insertPrincipal } from './helpers/principal-store-fixture.js'

const posix = process.platform !== 'win32'
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-kill-'))
  return { dir, path: join(dir, 'principals-disabled.json'), storePath: join(dir, 'principals.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const flag = (all, labels = []) => JSON.stringify({ version: 1, all, labels, updatedAt: 1 })

describe('boot read: absent means enabled, anything untrustworthy means disabled for all', () => {
  it('an absent file is never-killed: enabled, healthy', () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path })
      assert.equal(sw.isDisabled('any'), false)
      assert.deepEqual(sw.snapshot(), { all: false, labels: [] })
      assert.equal(sw.health().ok, true)
    } finally { d.cleanup() }
  })

  it('positive control: a valid 0600 file is read as written', { skip: !posix }, () => {
    const d = fresh()
    try {
      writeFileSync(d.path, flag(false, ['a', 'b']), { mode: 0o600 })
      const sw = new PrincipalKillSwitch({ path: d.path })
      assert.equal(sw.isDisabled('a'), true)
      assert.equal(sw.isDisabled('c'), false)
      assert.equal(sw.health().ok, true)
    } finally { d.cleanup() }
  })

  const bad = {
    'corrupt JSON': (p) => writeFileSync(p, '{not json', { mode: 0o600 }),
    'an unknown shape': (p) => writeFileSync(p, JSON.stringify({ version: 1, all: 'no', labels: [] }), { mode: 0o600 }),
    'a wrong version': (p) => writeFileSync(p, JSON.stringify({ version: 2, all: false, labels: [] }), { mode: 0o600 }),
    'a bad label entry': (p) => writeFileSync(p, JSON.stringify({ version: 1, all: false, labels: ['Bad Label'] }), { mode: 0o600 }),
    'an oversized file': (p) => writeFileSync(p, flag(false, []) + ' '.repeat(20 * 1024), { mode: 0o600 }),
    'an empty file': (p) => writeFileSync(p, '', { mode: 0o600 }),
    'a file that is not 0600': (p) => { writeFileSync(p, flag(false), { mode: 0o600 }); chmodSync(p, 0o644) },
    'a symlink': (p) => { writeFileSync(`${p}.real`, flag(false), { mode: 0o600 }); symlinkSync(`${p}.real`, p) },
    'a directory': (p) => mkdirSync(p),
  }
  for (const [name, make] of Object.entries(bad)) {
    it(`${name}: every principal is disabled and health says why`, { skip: !posix }, () => {
      const d = fresh()
      try {
        make(d.path)
        const sw = new PrincipalKillSwitch({ path: d.path })
        assert.equal(sw.isDisabled('anything'), true, 'disabled for ALL')
        assert.equal(sw.snapshot().all, true)
        assert.equal(sw.health().ok, false)
        assert.ok(/chroxy agent enable --all/.test(sw.health().reason))
      } finally { d.cleanup() }
    })
  }

  it('a read that throws fails closed as well', () => {
    const sw = new PrincipalKillSwitch({ path: '/nonexistent/x', readSecret: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }) } })
    assert.equal(sw.isDisabled('x'), true)
    assert.equal(sw.health().ok, false)
  })
})

describe('disable: memory first, then the durable write, then the verdict', () => {
  it('flips memory BEFORE the write starts, and the file holds the state when the call returns', { skip: !posix }, () => {
    const d = fresh()
    try {
      const seen = []
      let sw
      sw = new PrincipalKillSwitch({
        path: d.path,
        writeDurable: (p, data) => { seen.push({ disabledAtWrite: sw.isDisabled('x'), fileExists: existsSync(p) }); return writeDurableFile(p, data) },
      })
      const out = sw.disable({ all: true })
      assert.deepEqual(seen, [{ disabledAtWrite: true, fileExists: false }], 'memory was already disabled when the write began, and nothing was on disk')
      assert.equal(out.ok, true)
      assert.equal(out.durable, true)
      const onDisk = JSON.parse(readFileSync(d.path, 'utf8'))
      assert.equal(onDisk.all, true)
      assert.equal(onDisk.version, 1)
      assert.equal(statSync(d.path).mode & 0o777, 0o600)
    } finally { d.cleanup() }
  })

  it('a write that throws leaves memory DISABLED and reports not durable', () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path, writeDurable: () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) } })
      const out = sw.disable({ label: 'sup' })
      assert.equal(out.ok, true)
      assert.equal(out.durable, false)
      assert.equal(out.persistError, 'ENOSPC')
      assert.equal(sw.isDisabled('sup'), true)
    } finally { d.cleanup() }
  })

  it('a failed DIRECTORY fsync reports durable: false, the file is live, memory stays disabled', { skip: !posix }, () => {
    const d = fresh()
    try {
      let n = 0
      const sw = new PrincipalKillSwitch({ path: d.path, writeDurable: (p, data) => writeDurableFile(p, data, { _fsync: () => { if (++n === 2) throw Object.assign(new Error('EIO dir'), { code: 'EIO' }) } }) })
      const out = sw.disable({ all: true })
      assert.equal(out.durable, false)
      assert.ok(/EIO/.test(out.persistError))
      assert.equal(sw.isDisabled('x'), true)
      assert.equal(JSON.parse(readFileSync(d.path, 'utf8')).all, true)
    } finally { d.cleanup() }
  })

  it('--label disables only that label; --all disables every label; a malformed selector changes nothing', { skip: !posix }, () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path })
      assert.equal(sw.disable({ label: 'one' }).ok, true)
      assert.equal(sw.isDisabled('one'), true)
      assert.equal(sw.isDisabled('two'), false)
      assert.equal(sw.disable({}).code, 'BAD_REQUEST')
      assert.equal(sw.disable({ label: 'Bad Label' }).code, 'BAD_REQUEST')
      assert.equal(sw.disable({ all: false }).code, 'BAD_REQUEST')
      assert.equal(sw.isDisabled('two'), false)
      sw.disable({ all: true })
      assert.equal(sw.isDisabled('two'), true)
    } finally { d.cleanup() }
  })

  it('REAL RESTART: a new switch over the same dir is still disabled after a kill', { skip: !posix }, () => {
    const d = fresh()
    try {
      new PrincipalKillSwitch({ path: d.path }).disable({ label: 'sup' })
      const after = new PrincipalKillSwitch({ path: d.path })
      assert.equal(after.isDisabled('sup'), true)
      assert.equal(after.isDisabled('other'), false)
      new PrincipalKillSwitch({ path: d.path }).disable({ all: true })
      assert.equal(new PrincipalKillSwitch({ path: d.path }).isDisabled('other'), true)
    } finally { d.cleanup() }
  })
})

describe('enable is explicit and the permissive direction publishes before memory flips', () => {
  it('enable --all clears everything, and survives a restart', { skip: !posix }, () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path })
      sw.disable({ all: true })
      sw.disable({ label: 'x' })
      assert.equal(sw.enable({ all: true }).ok, true)
      assert.equal(sw.isDisabled('x'), false)
      assert.equal(new PrincipalKillSwitch({ path: d.path }).isDisabled('x'), false)
    } finally { d.cleanup() }
  })

  it('enable --label cannot lift one label while everything is disabled', { skip: !posix }, () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path })
      sw.disable({ all: true })
      assert.equal(sw.enable({ label: 'x' }).code, 'ALL_DISABLED')
      assert.equal(sw.isDisabled('x'), true)
      sw.enable({ all: true })
      sw.disable({ label: 'x' })
      assert.equal(sw.enable({ label: 'x' }).ok, true)
      assert.equal(sw.isDisabled('x'), false)
    } finally { d.cleanup() }
  })

  it('a write that throws leaves the daemon DISABLED (and the file as it was)', { skip: !posix }, () => {
    const d = fresh()
    try {
      const sw = new PrincipalKillSwitch({ path: d.path })
      sw.disable({ all: true })
      sw._writeDurable = () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }) }
      const out = sw.enable({ all: true })
      assert.equal(out.ok, false)
      assert.equal(out.code, 'PERSIST_FAILED')
      assert.equal(sw.isDisabled('x'), true)
      assert.equal(JSON.parse(readFileSync(d.path, 'utf8')).all, true)
    } finally { d.cleanup() }
  })

  it('enable --all recovers from an untrusted boot file by rewriting a good one', { skip: !posix }, () => {
    const d = fresh()
    try {
      writeFileSync(d.path, '{garbage', { mode: 0o600 })
      const sw = new PrincipalKillSwitch({ path: d.path })
      assert.equal(sw.isDisabled('x'), true)
      assert.equal(sw.enable({ all: true }).ok, true)
      assert.equal(sw.isDisabled('x'), false)
      assert.equal(sw.health().ok, true)
      assert.equal(new PrincipalKillSwitch({ path: d.path }).isDisabled('x'), false)
    } finally { d.cleanup() }
  })
})

describe('the store brakes: state() is the one choke point', () => {
  const build = (d, over = {}) => {
    const sw = new PrincipalKillSwitch({ path: d.path })
    let audit = true
    const store = new PrincipalStore({ path: d.storePath, allowTestInsert: true, brakes: { killSwitch: sw, auditAvailable: () => audit }, ...over })
    store.refresh()
    return { sw, store, setAudit: (v) => { audit = v } }
  }

  it('positive control: a live principal with both brakes off validates', { skip: !posix }, () => {
    const d = fresh()
    try {
      const { store } = build(d)
      const { token } = insertPrincipal(store)
      assert.equal(store.state('pr-1'), 'live')
      assert.ok(store.validate(token))
    } finally { d.cleanup() }
  })

  it('--label disables only that label; --all disables every principal; enable restores', { skip: !posix }, () => {
    const d = fresh()
    try {
      const { sw, store } = build(d)
      const a = insertPrincipal(store, { principalId: 'pr-a', label: 'alpha' })
      const b = insertPrincipal(store, { principalId: 'pr-b', label: 'beta' })
      sw.disable({ label: 'alpha' })
      assert.equal(store.state('pr-a'), 'disabled')
      assert.equal(store.validate(a.token), null, 'auth refused')
      assert.ok(store.validate(b.token))
      sw.disable({ all: true })
      assert.equal(store.validate(b.token), null)
      assert.equal(store.list().principals.find((p) => p.principalId === 'pr-b').state, 'disabled')
      sw.enable({ all: true })
      assert.ok(store.validate(a.token))
    } finally { d.cleanup() }
  })

  it('with file logging unavailable no principal authenticates or stays live; it returns with logging', { skip: !posix }, () => {
    const d = fresh()
    try {
      const { store, setAudit } = build(d)
      const { token } = insertPrincipal(store)
      setAudit(false)
      assert.equal(store.validate(token), null)
      assert.equal(store.state('pr-1'), 'invalid')
      assert.equal(store.isLive('pr-1'), false)
      setAudit(true)
      assert.ok(store.validate(token))
    } finally { d.cleanup() }
  })

  it('a brake that throws fails closed', { skip: !posix }, () => {
    const d = fresh()
    try {
      const store = new PrincipalStore({ path: d.storePath, allowTestInsert: true, brakes: { killSwitch: { isDisabled: () => { throw new Error('x') } }, auditAvailable: () => true } })
      store.refresh()
      insertPrincipal(store)
      assert.equal(store.isLive('pr-1'), false)
      const s2 = new PrincipalStore({ path: d.storePath, brakes: { killSwitch: { isDisabled: () => false }, auditAvailable: () => { throw new Error('x') } } })
      s2.refresh()
      assert.equal(s2.isLive('pr-1'), false)
    } finally { d.cleanup() }
  })

  it('a REAL restart after a kill and after a revoke: a new store and switch over the same dir stay disabled / revoked', { skip: !posix }, () => {
    const d = fresh()
    try {
      const first = build(d)
      const killed = insertPrincipal(first.store, { principalId: 'pr-k', label: 'killme' })
      const revoked = insertPrincipal(first.store, { principalId: 'pr-r', label: 'revokeme' })
      first.sw.disable({ label: 'killme' })
      first.store.revoke({ principalId: 'pr-r' })
      const second = build(d)
      assert.equal(second.store.validate(killed.token), null)
      assert.equal(second.store.state('pr-k'), 'disabled')
      assert.equal(second.store.validate(revoked.token), null)
      assert.equal(second.store.state('pr-r'), 'revoked')
    } finally { d.cleanup() }
  })

  it('attachBrakes is one-shot and validates its argument; the production brakes read the real audit path', () => {
    const store = new PrincipalStore({ path: '/nonexistent/p.json' })
    assert.throws(() => store.attachBrakes({}), /need a killSwitch/)
    const brakes = createPrincipalBrakes({ killSwitch: { isDisabled: () => false } })
    store.attachBrakes(brakes)
    assert.throws(() => store.attachBrakes(brakes), /already attached/)
    assert.equal(brakes.auditAvailable(), false, 'no file logging in this process: principal access would be refused')
  })

  it('grant still refuses', () => {
    const store = new PrincipalStore({ path: '/nonexistent/p.json' })
    assert.throws(() => store.grant(), /agent principals not yet enabled/)
  })
})
