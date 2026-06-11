import { describe, it, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { SessionManager } from '../src/session-manager.js'
import { SessionPresetTrustStore } from '../src/session-preset-trust.js'

/**
 * #5553 — createSession integration: the repo preamble folds into the
 * `sessionPreamble` ctor opt (trust-gated), the seed + metadata land on the
 * entry descriptor, and a pending preset injects nothing.
 *
 * A capturing provider records the `sessionPreamble` it was constructed with so
 * we can assert the fold without spawning a real process. All filesystem
 * touchpoints are temp dirs; the preset trust store + config path are
 * temp-pathed so the sandbox guard never fires.
 */

let registerProvider
let lastPreamble = null

before(async () => {
  ({ registerProvider } = await import('../src/providers.js'))

  class CapturingProvider extends EventEmitter {
    constructor(opts) {
      super()
      this.cwd = opts.cwd
      this.model = opts.model || null
      this.permissionMode = opts.permissionMode || 'approve'
      this.isRunning = false
      this.resumeSessionId = null
      lastPreamble = opts.sessionPreamble ?? null
    }
    static get capabilities() { return {} }
    start() {}
    destroy() {}
    sendMessage() {}
    interrupt() {}
    setModel() {}
    setPermissionMode() {}
    getPendingBackgroundShells() { return [] }
  }
  registerProvider('test-preset-capture', CapturingProvider)
})

describe('session-preset createSession integration', () => {
  let root
  let repo
  let stateFile
  let trustPath
  let configPath

  function makeMgr() {
    return new SessionManager({
      skipPreflight: true,
      maxSessions: 10,
      defaultCwd: repo,
      providerType: 'test-preset-capture',
      stateFilePath: stateFile,
      presetTrustStore: new SessionPresetTrustStore({ filePath: trustPath }),
      presetConfigPath: configPath,
    })
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chroxy-preset-cs-'))
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    stateFile = join(root, 'state.json')
    trustPath = join(root, 'preset-trust.json')
    configPath = join(root, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [] }))
    lastPreamble = null
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeRepoPreset(obj) {
    mkdirSync(join(repo, '.chroxy'), { recursive: true })
    writeFileSync(join(repo, '.chroxy', 'session.json'), JSON.stringify(obj))
  }

  it('a PENDING repo preset injects no preamble but is surfaced', () => {
    writeRepoPreset({ preamble: 'REPO-RULE', seed: 'do the thing' })
    const mgr = makeMgr()
    const id = mgr.createSession({ cwd: repo })
    // Pending preset must not fold into the preamble. With no session-level
    // preamble either, the provider sees no preamble at all (null/empty).
    assert.ok(!lastPreamble, 'pending preset must not fold into the preamble')
    const preset = mgr.getSessionPreset(id)
    assert.equal(preset.trustState, 'pending')
    assert.equal(preset.active, false)
    // Seed is withheld until active.
    assert.equal(preset.seed, '')
    assert.equal(preset.preambleLength, 'REPO-RULE'.length)
    mgr.shutdown?.()
  })

  it('an APPROVED repo preset folds into sessionPreamble (repo first) and stages the seed', () => {
    writeRepoPreset({ preamble: 'REPO-RULE', seed: 'do the thing' })
    const mgr = makeMgr()
    // Approve via the MANAGER's own trust store so the in-memory ledger the
    // resolver consults at createSession reflects the grant.
    const approved = mgr.approveSessionPreset(repo)
    assert.equal(approved.trustState, 'trusted')

    const id = mgr.createSession({ cwd: repo, sessionPreamble: 'SESSION-RULE' })
    assert.equal(lastPreamble, 'REPO-RULE\n\nSESSION-RULE', 'repo preamble comes first')
    const preset = mgr.getSessionPreset(id)
    assert.equal(preset.trustState, 'trusted')
    assert.equal(preset.active, true)
    assert.equal(preset.seed, 'do the thing', 'seed is staged for an active preset')
    mgr.shutdown?.()
  })

  it('a DAEMON override is pre-trusted and folds without approval', () => {
    writeFileSync(configPath, JSON.stringify({
      repos: [{ path: repo, sessionPreset: { preamble: 'DAEMON-RULE', seed: 'daemon seed' } }],
    }))
    const mgr = makeMgr()
    const id = mgr.createSession({ cwd: repo })
    assert.equal(lastPreamble, 'DAEMON-RULE')
    const preset = mgr.getSessionPreset(id)
    assert.equal(preset.source, 'daemon')
    assert.equal(preset.active, true)
    assert.equal(preset.seed, 'daemon seed')
    mgr.shutdown?.()
  })

  it('approveSessionPreset flips a pending preset to active', () => {
    writeRepoPreset({ preamble: 'P', seed: 'S' })
    const mgr = makeMgr()
    const before = mgr.resolveSessionPresetForCwd(repo)
    assert.equal(before.active, false)
    const after = mgr.approveSessionPreset(repo)
    assert.equal(after.active, true)
    assert.equal(after.trustState, 'trusted')
    mgr.shutdown?.()
  })

  it('no preset → no descriptor, no preamble', () => {
    const mgr = makeMgr()
    const id = mgr.createSession({ cwd: repo, sessionPreamble: 'ONLY-SESSION' })
    assert.equal(lastPreamble, 'ONLY-SESSION')
    assert.equal(mgr.getSessionPreset(id), null)
    mgr.shutdown?.()
  })
})
