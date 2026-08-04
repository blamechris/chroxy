import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeSchedulerEnabledToConfig, isSchedulerEnabled } from '../src/config.js'

// #6871 — the persisted scheduled-execution gate writer. Always driven against a
// TEMP config path; never ~/.chroxy/config.json (the sandbox guard would throw,
// and clobbering the operator's real config is exactly what must not happen).

const TMP = mkdtempSync(join(tmpdir(), 'chroxy-sched-gate-'))
process.on('exit', () => { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

let n = 0
const cfgPath = () => join(TMP, `config-${++n}.json`)
const read = (p) => JSON.parse(readFileSync(p, 'utf-8'))

describe('#6871 writeSchedulerEnabledToConfig', () => {
  it('creates the file (and its dir) with the flag set', () => {
    const p = join(TMP, 'nested', 'deeper', 'config.json')
    writeSchedulerEnabledToConfig(true, p)
    assert.equal(read(p).features.scheduler, true)
  })

  it('PRESERVES every other config field', () => {
    const p = cfgPath()
    writeFileSync(p, JSON.stringify({
      port: 9999,
      repos: [{ path: '/a' }],
      workspaceRoots: ['/w'],
      features: { ide: true, orchestration: true },
    }))
    writeSchedulerEnabledToConfig(true, p)
    const out = read(p)
    assert.equal(out.port, 9999)
    assert.deepEqual(out.repos, [{ path: '/a' }])
    assert.deepEqual(out.workspaceRoots, ['/w'])
    // Sibling feature flags must survive — a scheduler toggle must not disable IDE.
    assert.equal(out.features.ide, true)
    assert.equal(out.features.orchestration, true)
    assert.equal(out.features.scheduler, true)
  })

  it('round-trips true → false', () => {
    const p = cfgPath()
    writeSchedulerEnabledToConfig(true, p)
    assert.equal(read(p).features.scheduler, true)
    writeSchedulerEnabledToConfig(false, p)
    assert.equal(read(p).features.scheduler, false)
  })

  it('coerces a non-boolean to a strict boolean (never a truthy string on disk)', () => {
    const p = cfgPath()
    writeSchedulerEnabledToConfig('yes', p)
    // isSchedulerEnabled only honours `=== true`, so persisting 'yes' would be a
    // flag that reads as enabled to a human and disabled to the daemon.
    assert.equal(read(p).features.scheduler, false)
  })

  it('repairs a non-object `features` rather than throwing', () => {
    for (const bad of ['nope', 42, null, ['a']]) {
      const p = cfgPath()
      writeFileSync(p, JSON.stringify({ features: bad, port: 1 }))
      writeSchedulerEnabledToConfig(true, p)
      const out = read(p)
      assert.equal(out.features.scheduler, true, JSON.stringify(bad))
      assert.equal(out.port, 1, 'unrelated fields still preserved')
    }
  })

  it('THROWS on unparseable JSON instead of starting fresh (#7027)', () => {
    // "Start fresh" here meant replacing the operator's entire config with
    // `{ features: { scheduler: true } }`. The handler reports the throw as
    // SCHEDULER_GATE_FAILED rather than silently destroying the file.
    const p = cfgPath()
    writeFileSync(p, '{ not json')
    assert.throws(() => writeSchedulerEnabledToConfig(true, p), /Refusing to overwrite/)
    assert.equal(readFileSync(p, 'utf-8'), '{ not json')
  })

  it('writes with restricted (0600) permissions', () => {
    const p = cfgPath()
    writeSchedulerEnabledToConfig(true, p)
    assert.equal(statSync(p).mode & 0o777, 0o600)
  })

  it('what it writes is what isSchedulerEnabled reads', () => {
    // The round-trip that matters: the writer and the gate reader must agree.
    const prev = process.env.CHROXY_ENABLE_SCHEDULER
    delete process.env.CHROXY_ENABLE_SCHEDULER
    try {
      const p = cfgPath()
      writeSchedulerEnabledToConfig(true, p)
      assert.equal(isSchedulerEnabled(read(p)), true)
      writeSchedulerEnabledToConfig(false, p)
      assert.equal(isSchedulerEnabled(read(p)), false)
    } finally {
      if (prev === undefined) delete process.env.CHROXY_ENABLE_SCHEDULER
      else process.env.CHROXY_ENABLE_SCHEDULER = prev
    }
  })

  it('the env var still overrides a persisted false (documented precedence)', () => {
    const prev = process.env.CHROXY_ENABLE_SCHEDULER
    process.env.CHROXY_ENABLE_SCHEDULER = '1'
    try {
      const p = cfgPath()
      writeSchedulerEnabledToConfig(false, p)
      assert.equal(read(p).features.scheduler, false)
      assert.equal(isSchedulerEnabled(read(p)), true, 'env wins — the handler refuses this combination for that reason')
    } finally {
      if (prev === undefined) delete process.env.CHROXY_ENABLE_SCHEDULER
      else process.env.CHROXY_ENABLE_SCHEDULER = prev
    }
  })
})
