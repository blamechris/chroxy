// Tests for the boot-time OrchestrationManager factory (E-4 part 3c). The
// load-bearing property: it NEVER throws — a disabled feature or a construction
// error returns null so the orchestration engine can't break daemon boot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { buildOrchestrationManager } from '../src/orchestration/build-manager.js'
import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'

const tmpDirs = []
function tmp() { const d = mkdtempSync(join(tmpdir(), 'buildmgr-')); tmpDirs.push(d); return d }
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } } })

test('returns null when the feature is off (fail-closed default)', () => {
  const sm = new EventEmitter()
  // flag-off never touches the dir at all
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: {}, chroxyDir: '/nonexistent' }), null)
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: { features: {} }, chroxyDir: '/nonexistent' }), null)
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: { features: { orchestration: false } }, chroxyDir: '/nonexistent' }), null)
  // and attaches ZERO listeners to the session manager (total no-op)
  assert.equal(sm.eventNames().length, 0, 'flag-off attaches no listeners')
})

test('constructs a wired manager when features.orchestration is on', () => {
  const dir = tmp()
  const sm = new EventEmitter() // TurnDriver only needs .on
  sm.listSessions = () => []
  try {
    const mgr = buildOrchestrationManager({
      sessionManager: sm,
      config: { features: { orchestration: true }, orchestration: { roles: { architect: { provider: 'claude-sdk', model: 'm' }, worker: { provider: 'codex', model: 'm' } } } },
      chroxyDir: dir,
      log: null,
    })
    assert.ok(mgr instanceof OrchestrationManager, 'returns an OrchestrationManager')
    // it can serve its read API without a run (empty list)
    assert.deepEqual(mgr.listRuns(), [])
    mgr.dispose?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('returns null (never throws) when construction fails', () => {
  const warnings = []
  const log = { info: () => {}, warn: (m) => warnings.push(m) }
  // sessionManager without .on → TurnDriver constructor throws → caught → null
  const mgr = buildOrchestrationManager({
    sessionManager: {}, config: { features: { orchestration: true } }, chroxyDir: tmp(), log,
  })
  assert.equal(mgr, null)
  assert.ok(warnings.some((w) => /failed to initialize/i.test(w)), 'logged a warning')
})

test('recovers prior run records from disk at boot (index not clobbered)', () => {
  const dir = tmp()
  // cwd must be a REAL directory within (a fake) $HOME — the factory wires
  // validateCwdAllowed, which stats it and enforces the within-home rule.
  const fakeHome = tmp()
  const cwd = join(fakeHome, 'repo')
  mkdirSync(cwd, { recursive: true })
  const cfg = {
    features: { orchestration: true }, homeOverride: fakeHome,
    orchestration: { roles: { architect: { provider: 'claude-sdk', model: 'm' }, worker: { provider: 'codex', model: 'm' } } },
  }
  const mkSm = () => { const sm = new EventEmitter(); sm.listSessions = () => []; return sm }
  // boot 1: create a run and dispose (flushes run.json)
  const mgr1 = buildOrchestrationManager({ sessionManager: mkSm(), config: cfg, chroxyDir: dir })
  const rec = mgr1.createRun({ goal: 'g', cwd })
  mgr1.dispose()
  // boot 2: the prior run is recovered — listRuns sees it (no empty-map clobber)
  const mgr2 = buildOrchestrationManager({ sessionManager: mkSm(), config: cfg, chroxyDir: dir })
  const runs = mgr2.listRuns()
  assert.equal(runs.length, 1, 'prior run recovered at boot')
  assert.equal(runs[0].runId, rec.runId)
  mgr2.dispose()
})

test('dispose() unhooks the engine listeners from the session manager', () => {
  const dir = tmp()
  const sm = new EventEmitter()
  sm.listSessions = () => []
  const before = sm.eventNames().length
  const mgr = buildOrchestrationManager({
    sessionManager: sm,
    config: { features: { orchestration: true }, orchestration: { roles: { architect: { provider: 'claude-sdk', model: 'm' }, worker: { provider: 'codex', model: 'm' } } } },
    chroxyDir: dir,
  })
  assert.ok(sm.eventNames().length > before, 'engine attached listeners (turn driver)')
  mgr.dispose()
  assert.equal(sm.eventNames().length, before, 'dispose removed every engine listener')
})

test('honors the CHROXY_ENABLE_ORCHESTRATION=1 env override', () => {
  const prev = process.env.CHROXY_ENABLE_ORCHESTRATION
  process.env.CHROXY_ENABLE_ORCHESTRATION = '1'
  const dir = tmp()
  const sm = new EventEmitter()
  sm.listSessions = () => []
  try {
    const mgr = buildOrchestrationManager({ sessionManager: sm, config: {}, chroxyDir: dir })
    assert.ok(mgr instanceof OrchestrationManager, 'env override enables the engine even with no config')
    mgr.dispose?.()
  } finally {
    if (prev === undefined) delete process.env.CHROXY_ENABLE_ORCHESTRATION
    else process.env.CHROXY_ENABLE_ORCHESTRATION = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
