// Tests for the boot-time OrchestrationManager factory (E-4 part 3c). The
// load-bearing property: it NEVER throws — a disabled feature or a construction
// error returns null so the orchestration engine can't break daemon boot.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'

import { buildOrchestrationManager } from '../src/orchestration/build-manager.js'
import { OrchestrationManager } from '../src/orchestration/orchestration-manager.js'

function tmp() { return mkdtempSync(join(tmpdir(), 'buildmgr-')) }

test('returns null when the feature is off (fail-closed default)', () => {
  const sm = new EventEmitter()
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: {}, chroxyDir: tmp() }), null)
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: { features: {} }, chroxyDir: tmp() }), null)
  assert.equal(buildOrchestrationManager({ sessionManager: sm, config: { features: { orchestration: false } }, chroxyDir: tmp() }), null)
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
